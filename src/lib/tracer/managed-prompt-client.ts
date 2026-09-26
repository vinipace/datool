import { trace } from "@opentelemetry/api"
import { getDatoolCallContext } from "./call-context"
import { getPromptScope, withPromptScope } from "./prompt-scope"
import {
  promptSlugSchema,
  promptOverrideSchema,
  promptOverridesSchema,
  type PromptOverride,
  type PromptOverrides,
  type FrozenPromptConfig,
} from "./prompt-overrides"
import {
  promptInputSchema,
  renderPrompt,
  type ManagedPrompt,
  type PromptMessage,
} from "./prompts"

export type RuntimePrompt = Omit<ManagedPrompt, "version"> & {
  version: number
  settings: {
    temperature?: number
    maxTokens?: number
    output: "text" | "json"
  }
  render(variables?: Record<string, string>): PromptMessage[]
}
export type PromptCacheOptions = { latestTtlMs?: number; maxEntries?: number }
type Request = <T>(
  path: string,
  method?: "GET" | "POST" | "PATCH",
  body?: unknown,
  delivery?: "direct"
) => Promise<T>

export class DatoolPrompts {
  private readonly cache = new Map<
    string,
    { value: ManagedPrompt; expires: number }
  >()
  private readonly pending = new Map<string, Promise<ManagedPrompt>>()
  private readonly runs = new WeakMap<object, Promise<FrozenPromptConfig>>()
  private readonly ttl: number
  private readonly capacity: number
  constructor(
    private readonly request: Request,
    private readonly scope: { projectId?: string; baseUrl: string },
    options: PromptCacheOptions = {}
  ) {
    this.ttl = options.latestTtlMs ?? 30_000
    this.capacity = options.maxEntries ?? 256
    if (!Number.isFinite(this.ttl) || this.ttl < 0 || this.ttl > 300_000)
      throw new Error("latestTtlMs must be between 0 and 300000.")
    if (
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 10_000
    )
      throw new Error("maxEntries must be between 1 and 10000.")
  }
  override(slug: string, override: PromptOverride) {
    promptSlugSchema.parse(slug)
    const value = promptOverrideSchema.parse(override)
    const scope = getPromptScope()
    if (!scope)
      throw new Error(
        "Prompt overrides require connect or prompts.withScope()."
      )
    const overrides =
      scope.clients.get(this) ?? (Object.create(null) as PromptOverrides)
    overrides[slug] = value
    scope.clients.set(this, overrides)
  }
  reset(slug: string) {
    promptSlugSchema.parse(slug)
    const scope = getPromptScope()
    if (!scope)
      throw new Error("Prompt reset requires connect or prompts.withScope().")
    delete scope.clients.get(this)?.[slug]
  }
  withScope<T>(overrides: PromptOverrides, action: () => T): T {
    const parsed = promptOverridesSchema.parse(overrides)
    return withPromptScope(() => {
      for (const [slug, override] of Object.entries(parsed))
        this.override(slug, override)
      return action()
    })
  }
  private async frozen() {
    const scope = getPromptScope()
    if (!scope?.run) return
    if (
      scope.run.projectId !== this.scope.projectId ||
      (scope.run.baseUrl &&
        scope.run.baseUrl.replace(/\/$/, "") !== this.scope.baseUrl)
    )
      throw new Error(
        "Connected prompt scope does not match this Datool client's project or server."
      )
    let request = this.runs.get(scope)
    if (!request) {
      request = this.request<FrozenPromptConfig>(
        `/api/evals/${encodeURIComponent(scope.run.runId)}/prompts`
      )
      this.runs.set(scope, request)
      request.catch(() => this.runs.delete(scope))
    }
    const frozen = await request
    if (frozen.projectId !== this.scope.projectId)
      throw new Error("Invalid prompt snapshot project.")
    return frozen
  }
  private remember(key: string, value: ManagedPrompt, expires: number) {
    this.cache.delete(key)
    this.cache.set(key, { value, expires })
    while (this.cache.size > this.capacity)
      this.cache.delete(this.cache.keys().next().value!)
  }
  private fetch(slug: string, version?: number) {
    const key = `${slug}:${version ?? "latest"}`
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) {
      this.remember(key, cached.value, cached.expires)
      return Promise.resolve(cached.value)
    }
    const pending = this.pending.get(key)
    if (pending) return pending
    const request = this.request<ManagedPrompt>(
      `/api/prompts/by-slug/${encodeURIComponent(slug)}${version ? `?version=${version}` : ""}`
    )
      .then((value) => {
        promptInputSchema.parse(value)
        if (
          !Number.isSafeInteger(value.version) ||
          value.version! < 1 ||
          value.slug !== slug ||
          (version && value.version !== version)
        )
          throw new Error("Datool returned an invalid published prompt.")
        const copy = structuredClone(value)
        this.remember(`${slug}:${copy.version}`, copy, Infinity)
        if (!version) this.remember(key, copy, Date.now() + this.ttl)
        return copy
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return request
  }
  async get(
    slug: string,
    options: { version?: number } = {}
  ): Promise<RuntimePrompt> {
    promptSlugSchema.parse(slug)
    const requested = promptOverrideSchema.parse(options)
    // Capture before awaiting: later overrides cannot change an in-flight get.
    const overrides = getPromptScope()?.clients.get(this)
    const override = structuredClone(
      overrides && Object.hasOwn(overrides, slug) ? overrides[slug] : {}
    )
    const frozen = await this.frozen()
    const pin =
      frozen && Object.hasOwn(frozen.prompts, slug)
        ? frozen.prompts[slug]
        : undefined
    if (frozen && !pin)
      throw new Error(`Prompt ${slug} was not published when this run started.`)
    const version = override.version ?? requested.version ?? pin?.version
    if (pin && version! > pin.latestVersion)
      throw new Error(
        `Prompt ${slug} version ${version} was published after this run started.`
      )
    const definition = structuredClone(await this.fetch(slug, version))
    if (pin && pin.id !== definition.id)
      throw new Error(`Prompt ${slug} identity changed after this run started.`)
    const model =
      override.model ?? frozen?.overrides[slug]?.model ?? definition.model
    const attributes = {
      "datool.prompt.id": definition.id,
      "datool.prompt.slug": slug,
      "datool.prompt.version": definition.version!,
      "datool.prompt.model": model,
    }
    trace.getActiveSpan()?.addEvent("datool.prompt.resolve", attributes)
    const call = getDatoolCallContext()
    if (call?.invocationTraceId) {
      const timestamp = new Date().toISOString()
      // Await direct persistence so failure paths and apps without telemetry still retain provenance.
      await this.request(
        `/api/traces/${encodeURIComponent(call.invocationTraceId)}/spans`,
        "POST",
        {
          id: `prompt_${crypto.randomUUID()}`,
          name: `Prompt: ${slug}`,
          kind: "custom",
          status: "completed",
          startedAt: timestamp,
          endedAt: timestamp,
          attributes: { ...attributes, "datool.call.id": call.callId },
        },
        "direct"
      )
    }
    const renderedDefinition = structuredClone(definition)
    return {
      ...definition,
      version: definition.version!,
      model,
      settings: {
        temperature: definition.temperature,
        maxTokens: definition.maxTokens,
        output: definition.output,
      },
      render: (variables = {}) => renderPrompt(renderedDefinition, variables),
    }
  }
}
