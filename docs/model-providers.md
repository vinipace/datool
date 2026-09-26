# Project model providers

Project settings → AI providers (`/p/<projectSlug>/settings/ai-providers`) lets
organization owners/admins add, replace, or remove a Vercel AI Gateway API key,
an OpenAI API key, or a TypeSafe AI API key. The table lists configured providers; **Add provider**
opens the provider picker and credential dialog. Members can read
configuration status, but cannot read or change credentials. A saved key means
configured, not verified: a scorer request checks its validity and model access.

Apply migrations with `bun run db:migrate`. `0020_project_model_providers.sql`
creates credential storage; `0028_typesafe_ai_provider.sql` adds TypeSafe AI to
the provider constraint while retaining existing Gateway keys.
`0031_openai_provider.sql` adds direct OpenAI credentials.
Keys are stored in PostgreSQL encrypted with AES-256-GCM and bound to the project
and provider. Encryption uses `DATOOL_PROVIDER_ENCRYPTION_KEY` when set, otherwise
a domain-separated key derived from `BETTER_AUTH_SECRET`. Keep the encryption
secret stable and shared across server processes. Rotating/changing that secret
requires admins to re-enter the provider keys. API responses contain only status
and update time, never plaintext, ciphertext, or a key preview.

Selecting a Gateway model persists `provider: "vercel-ai-gateway"` and a qualified
model ID such as `openai/gpt-4.1-mini`. Execution uses only that project's saved
key and the fixed Gateway endpoint; there is no server-wide Gateway fallback.
This applies to custom sample tests, recorded-trace tests, saved evaluations,
and immutable scorer versions. Existing scorers without `provider` keep their
server OpenAI configuration. Selecting a model in the editor selects its project provider and model together.

`components/ui/model-combobox.tsx` is a controlled reusable picker. Callers own
fetching and credentials. It filters by model type (language by default), searches
names, IDs, providers, creators and capability tags, and preserves saved IDs.
Each option is identified by the provider and model together. `ComboboxGroup`
headings identify providers; model legends show only the creator. There is no
separate provider field. Grouping preserves virtualization, search, keyboard
navigation, and the selected provider/model identity. Model creators are distinct from the Gateway provider; inference
routing among upstream hosts remains with Gateway. Catalog presence does not
guarantee the configured key permits a model or that it supports the scorer's
strict structured output request; execution reports those failures.

Scorers also offer Gateway models with type `evaluation`, including TypeSafe AI's
`typesafe-ai/jev`. Datool uses AI SDK 7's experimental `evaluate` API with the
project's saved Gateway key for these models. The scorer and its immutable
versions persist `modelType: "evaluation"`; existing versions without this field
continue to use Chat Completions. Rendered messages become the shared evaluation
state, and a typed Choice question maps the selected answer back to the configured
score and threshold. Skip choices remain unscored. Available probabilities,
TypeSafe confidence, and token usage are recorded in result metadata. Missing
usage or pricing is not treated as zero. Evaluation models do not return a written
reason, support image evidence, or use the chain-of-thought option. Selecting one
clears those unsupported settings. Prompt editors continue to offer language
models only.

For direct Jev access, choose **Add provider → TypeSafe AI** in project settings
and save a TypeSafe API key. In the scorer's single **Model** combobox, choose
**Jev** in the **TypeSafe AI** group (`jev-latest`). Gateway Jev appears in the
same list under **Vercel AI Gateway**. The scorer and immutable versions
persist `provider: "typesafe-ai"` and `modelType: "evaluation"`. Execution uses
`@ai-sdk/typesafe-ai` with the project's TypeSafe key and the fixed endpoint
`https://api.typesafe.ai/v1/systemone`. It does not use Gateway or a server-wide
`TYPESAFE_AI_API_KEY`. The direct model list uses the documented alias and remains
available during Gateway catalog outages. Direct version IDs are accepted by the
scorer API and preserved by the picker when saved.

Selecting a different model updates the provider and model atomically, including
when switching between direct and Gateway Jev. Key updates/removals affect only the chosen
provider in the chosen project, and executions never fall back to another key or
provider. Direct responses retain the resolved model ID, token usage, native
probabilities, and separate TypeSafe confidence. As with Gateway, a saved key is
configuration status; an evaluation request verifies access.

TypeSafe reference: [AI SDK provider](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai)
and [API documentation](https://docs.typesafe.ai/api).

Creator logos use `https://models.dev/logos/{creator}.svg`, the same source used
by Vercel AI Elements' ModelSelectorLogo. Logos are decorative, omit referrers,
adapt to dark mode, and fall back to a neutral icon on failure. Gateway does not
include logo URLs in its model catalog. `meta` maps to the `llama` logo.

The picker uses one shared hover card for all model options. Mouse enter updates
its model and anchor; mouse leave closes it after a short grace period so the
pointer can move onto the card. Selecting, searching, scrolling, or closing the
picker dismisses the preview. Details include the catalog description, context
and output limits, modalities, capabilities, and USD prices per million tokens.
Tiered prices show a range; absent prices remain unavailable rather than zero.
The catalog does not provide uptime history, so the card does not show uptime.

A 20px pie at the far right of each model option indicates relative token price.
The selected model shows it after the creator name. More fill means more expensive. The scale uses an equal mix of
input and output prices (highest rates for tiered pricing), with logarithmic
compression relative to the most expensive model of the selected type. Searching
does not rescale it. Free models have an empty pie; unknown pricing uses a dash
in the center. Exact rates remain in the hover card.

The project-authorized catalog route reads Vercel's public `/v1/models` endpoint
without credentials or trace data. The server caches metadata for an hour,
coalesces concurrent fetches, limits requests to ten seconds, backs off failed
refreshes for a minute, and serves the last successful catalog with a stale flag.

References: [authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok),
[model discovery](https://vercel.com/docs/ai-gateway/models-and-providers),
[Chat Completions REST API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/rest-api).

## Direct OpenAI

Choose **Add provider → OpenAI** and save the project's OpenAI API key.
Prompt and scorer model pickers include an **OpenAI** group derived from the
same cached Gateway catalog: descriptions, prices, context/output limits,
modalities, and tags are reused without a second metadata request. Prices shown
are Gateway catalog estimates, not an account-specific OpenAI quote.
Gateway-only `-fast` aliases and third-party-hosted `gpt-oss-*` models remain
under Gateway. `openai/gpt-5.1-thinking` maps to OpenAI's `gpt-5.1`; other direct
IDs drop the `openai/` prefix. The API accepts direct IDs, including fine-tuned
IDs, and preserves saved selections when catalog refreshes fail.

Selections persist `provider: "openai"` and a direct ID such as `gpt-4.1-mini`.
Requests use only the project's encrypted OpenAI credential and the fixed
`https://api.openai.com/v1` endpoint. Modern models use Responses with
`store: false`; GPT-3.5 and GPT-4 Turbo retain Chat Completions. Scorers preserve
strict choice output, image evidence, resolved model, token usage, and refusal
and incomplete-response handling. OpenAI is not a native evaluation provider.
Existing providerless scorer versions retain their legacy server configuration.

Reference: [OpenAI Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses).
