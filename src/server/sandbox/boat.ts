import { randomUUID } from "node:crypto"
import type { SandboxProcess } from "eve/sandbox"

const baseUrl = "https://boat.dev/api/v1"
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000))
type BoatSandbox = {
  id: string
  state: string
  hydrated?: boolean
  dataExpiredAt?: string | null
}
class BoatError extends Error {
  constructor(public readonly status: number) {
    super(
      `Boat request failed (${status}). Check the API key, permissions and capacity.`
    )
  }
}

/** Fixed origin: neither project configuration nor sandbox output can redirect credentials. */
export class BoatClient {
  constructor(private readonly apiKey: string) {}
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    timeoutMs = 30_000,
    headers: Record<string, string> = {}
  ): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new Error(
        "Boat could not be reached. The operation may still be running."
      )
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new BoatError(response.status)
    }
    // Never propagate provider error bodies: they may contain secrets or submitted commands.
    try {
      return (await response.json()) as T
    } catch {
      throw new Error("Boat returned an invalid response.")
    }
  }
  async create(id: string, snapshots: boolean, ttlSeconds = 1200) {
    let result: { sandbox: BoatSandbox } | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await this.request<{ sandbox: BoatSandbox }>(
          "/sandboxes",
          "POST",
          {
            name: `datool-${id}`,
            type: "small",
            ttlSeconds,
            noEnv: true,
            visibility: "private",
            snapshots,
            monitoring: false,
            labels: { "datool.allocation": id },
          },
          30_000,
          { "Idempotency-Key": id }
        )
        break
      } catch (error) {
        if (
          attempt === 2 ||
          (error instanceof BoatError &&
            error.status < 500 &&
            error.status !== 409)
        )
          throw error
        await pause()
      }
    }
    if (
      !/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(
        result?.sandbox?.id ?? ""
      )
    )
      throw new Error("Boat returned an invalid sandbox identity.")
    return result!.sandbox.id
  }
  async get(id: string, timeoutMs = 30_000) {
    return (
      await this.request<{ sandbox: BoatSandbox }>(
        `/sandboxes/${encodeURIComponent(id)}`,
        "GET",
        undefined,
        timeoutMs
      )
    ).sandbox
  }
  async ready(id: string, resume = false, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs
    let resumed = false
    while (Date.now() < deadline) {
      const sandbox = await this.get(
        id,
        Math.max(1, Math.min(30_000, deadline - Date.now()))
      )
      if (
        ["ready", "idle", "running"].includes(sandbox.state) &&
        sandbox.hydrated !== false
      )
        return
      if (
        sandbox.state === "archived" &&
        resume &&
        !resumed &&
        !sandbox.dataExpiredAt
      ) {
        await this.request(`/sandboxes/${id}/resume`, "POST", {
          ttlSeconds: 1200,
        })
        resumed = true
      } else if (["error", "cancelled", "archived"].includes(sandbox.state)) {
        throw new Error(
          "Boat sandbox is unavailable. Its pending drive data has not been replaced."
        )
      }
      await pause()
    }
    throw new Error("Boat sandbox startup timed out.")
  }
  async stop(id: string) {
    try {
      await this.request(`/sandboxes/${id}/stop`, "POST", {})
    } catch (error) {
      if (error instanceof BoatError && error.status === 404) return
      throw error
    }
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      try {
        if (["archived", "cancelled"].includes((await this.get(id)).state))
          return
      } catch (error) {
        if (error instanceof BoatError && error.status === 404) return
        throw error
      }
      await pause()
    }
    throw new Error(
      "Boat has not confirmed shutdown. Automatic stop remains enabled."
    )
  }
  async command(id: string, command: string, seconds = 60) {
    const result = await this.request<{
      stdout: string
      stderr: string
      exitCode: number | null
      stdoutTruncated?: boolean
      stderrTruncated?: boolean
    }>(
      `/sandboxes/${id}/commands`,
      "POST",
      { command, timeoutSeconds: Math.min(600, seconds) },
      (seconds + 15) * 1000
    )
    if (
      result.exitCode !== 0 ||
      result.stdoutTruncated ||
      result.stderrTruncated
    )
      throw new Error("Boat container operation failed.")
    return result
  }
}

// The API carries UTF-8 logs. Frame binary output before it enters that transport,
// preserving arbitrary files, split UTF-8 sequences and separate output streams.
const relay = `import base64,json,os,selectors,subprocess,sys
args=json.loads(sys.argv[1]); input_path=sys.argv[2]
source=open(input_path,'rb') if input_path else subprocess.DEVNULL
p=subprocess.Popen(args,stdin=source,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
s=selectors.DefaultSelector()
s.register(p.stdout,selectors.EVENT_READ,'stdout'); s.register(p.stderr,selectors.EVENT_READ,'stderr')
while s.get_map():
 for key,_ in s.select():
  data=os.read(key.fileobj.fileno(),16384)
  if data: print(json.dumps({'stream':key.data,'data':base64.b64encode(data).decode()}),flush=True)
  else: s.unregister(key.fileobj)
sys.exit(p.wait())`

/** Docker inside a no-env Boat VM. User commands never execute on the VM host. */
export class BoatDocker {
  constructor(
    public readonly client: BoatClient,
    public readonly id: string
  ) {}
  async prepare(image: string, timeoutMs = 180_000) {
    await this.client.command(
      this.id,
      `docker image inspect ${shellQuote(image)} >/dev/null 2>&1 || docker pull ${shellQuote(image)}`,
      Math.max(1, Math.ceil(timeoutMs / 1000))
    )
  }
  async exec(
    args: string[],
    options: { timeout?: number; signal?: AbortSignal } = {}
  ) {
    options.signal?.throwIfAborted()
    return this.client.command(
      this.id,
      ["docker", ...args].map(shellQuote).join(" "),
      Math.min(600, Math.max(1, Math.ceil((options.timeout ?? 60_000) / 1000)))
    )
  }
  async remove(name: string) {
    await this.client.command(
      this.id,
      `docker info >/dev/null && if docker container inspect ${shellQuote(name)} >/dev/null 2>&1; then docker rm -f ${shellQuote(name)}; fi`
    )
  }
  spawn(args: string[], stdin = false): SandboxProcess {
    const out = new TransformStream<Uint8Array, Uint8Array>()
    const err = new TransformStream<Uint8Array, Uint8Array>()
    const writers = {
      stdout: out.writable.getWriter(),
      stderr: err.writable.getWriter(),
    }
    const chunks: Uint8Array[] = []
    let size = 0
    let processId: number | undefined
    let killed = false
    let finished = false
    let start!: () => void
    const inputReady = new Promise<void>((resolve) => {
      start = resolve
    })
    if (!stdin) start()
    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        size += chunk.byteLength
        if (size > 112 * 1024 * 1024) {
          killed = true
          start()
          throw new Error("Boat input exceeds the transfer limit.")
        }
        chunks.push(chunk.slice())
      },
      close() {
        start()
      },
      abort() {
        killed = true
        start()
      },
    })
    const waited = (async () => {
      const directory = `/tmp/datool-input-${randomUUID()}`
      try {
        await inputReady
        if (killed) throw new Error("Boat command was cancelled.")
        if (stdin) {
          const data = Buffer.concat(chunks)
          chunks.length = 0
          // File API accepts 5 MiB per request. Chunks are private host-side files,
          // never mounted into the untrusted container.
          await this.client.command(
            this.id,
            `mkdir -m 700 ${shellQuote(directory)} && touch ${shellQuote(directory + "/input")}`
          )
          for (let offset = 0; offset < data.length; offset += 1024 * 1024) {
            if (killed) throw new Error("Boat command was cancelled.")
            await this.client.request(`/sandboxes/${this.id}/files`, "PUT", {
              path: `${directory}/chunk`,
              content: data
                .subarray(offset, offset + 1024 * 1024)
                .toString("base64"),
              encoding: "base64",
            })
            await this.client.command(
              this.id,
              `cat ${shellQuote(directory + "/chunk")} >> ${shellQuote(directory + "/input")}`
            )
          }
        }
        if (killed) throw new Error("Boat command was cancelled.")
        const started = await this.client.request<{ processId: number }>(
          `/sandboxes/${this.id}/commands`,
          "POST",
          {
            command: [
              "python3",
              "-c",
              relay,
              JSON.stringify(["docker", ...args]),
              stdin ? `${directory}/input` : "",
            ]
              .map(shellQuote)
              .join(" "),
            timeoutSeconds: 600,
            detached: true,
          }
        )
        if (!Number.isSafeInteger(started.processId) || started.processId < 1)
          throw new Error("Boat returned an invalid process identity.")
        processId = started.processId
        if (killed)
          await this.client.request(
            `/sandboxes/${this.id}/commands/${processId}`,
            "DELETE"
          )
        let offset = 0,
          errorOffset = 0,
          pending = ""
        const deadline = Date.now() + 610_000
        while (Date.now() < deadline) {
          const status = await this.client.request<{
            running: boolean
            status: string
            exitCode: number | null
            stdout: string
            stderr: string
            stdoutOffset: number
            stdoutNextOffset: number
            stderrNextOffset: number
            stdoutTruncated?: boolean
            more?: boolean
          }>(
            `/sandboxes/${this.id}/commands/${processId}?stdoutOffset=${offset}&stderrOffset=${errorOffset}`
          )
          if (
            status.stdoutOffset !== offset ||
            !Number.isSafeInteger(status.stdoutNextOffset) ||
            status.stdoutNextOffset < offset ||
            status.stdoutTruncated
          )
            throw new Error("Boat command output was lost or truncated.")
          offset = status.stdoutNextOffset
          errorOffset = status.stderrNextOffset
          pending += status.stdout
          if (pending.length > 16 * 1024 * 1024)
            throw new Error("Boat output frame exceeds its limit.")
          let newline: number
          while ((newline = pending.indexOf("\n")) !== -1) {
            const frame = JSON.parse(pending.slice(0, newline)) as {
              stream: "stdout" | "stderr"
              data: string
            }
            pending = pending.slice(newline + 1)
            if (!(frame.stream in writers) || typeof frame.data !== "string")
              throw new Error("Invalid Boat output frame.")
            await writers[frame.stream].write(Buffer.from(frame.data, "base64"))
          }
          if (!status.running && !status.more) {
            if (
              pending ||
              status.status === "lost" ||
              status.exitCode === null ||
              status.stderr
            )
              throw new Error("Boat command did not finish cleanly.")
            finished = true
            await Promise.all([writers.stdout.close(), writers.stderr.close()])
            return { exitCode: status.exitCode }
          }
          if (!status.more) await pause()
        }
        throw new Error("Boat command timed out.")
      } catch {
        const error = new Error(
          "Boat command failed or its connection was interrupted."
        )
        await Promise.allSettled([
          writers.stdout.abort(error),
          writers.stderr.abort(error),
        ])
        throw error
      } finally {
        if (!finished && processId !== undefined)
          await this.client
            .request(`/sandboxes/${this.id}/commands/${processId}`, "DELETE")
            .catch(() => undefined)
        if (stdin)
          await this.client
            .command(this.id, `rm -rf -- ${shellQuote(directory)}`)
            .catch(() => undefined)
      }
    })()
    // Consumers attach wait/read handlers after spawn returns.
    void waited.catch(() => undefined)
    return {
      stdout: out.readable,
      stderr: err.readable,
      ...(stdin ? { stdin: input } : {}),
      wait: () => waited,
      kill: async () => {
        killed = true
        start()
        if (processId !== undefined)
          await this.client.request(
            `/sandboxes/${this.id}/commands/${processId}`,
            "DELETE"
          )
      },
    }
  }
}
