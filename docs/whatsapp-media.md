# Images and audio on the Evolution channel

Customer-initiated Evolution conversations accept JPEG, PNG and WebP images
(up to 5 MB) and audio/voice notes (up to 16 MB and five minutes). Replies remain
text. Group conversations, video, documents and view-once media are not supported.
The existing connection, recipient opt-out, 24-hour reply window and human
ownership rules still apply.

The webhook stores a provider message reference, media type and caption. The
worker resolves the original message in the authenticated Evolution instance and
checks that its sender matches the conversation before downloading it. It never
fetches the URL supplied in the webhook. Images are decoded with a pixel limit,
resized to 1600 pixels and passed to the agent's configured model on that turn.
The model must support vision. Raw images are not saved in conversation history
or traces; later turns retain the caption and the agent's textual interpretation.

Audio is decoded locally to bounded mono PCM using FFmpeg, including WhatsApp
OGG/Opus voice notes. It is sent through the project-configured Vercel AI Gateway using
`openai/gpt-transcribe`; the resulting
text becomes the user message for the agent and appears in the channel ledger.
Temporary audio files are removed after decoding, and audio bytes are not stored
in PostgreSQL. The transcript follows conversation retention/deletion.

## Provider billing, usage and retries

Transcription uses the same funding model as Build agent replies: the Gateway key
saved in the project's provider settings pays Vercel directly. Datool records the
cost in Build usage, attributed to the project, agent and conversation. It does
not reserve or deduct organization execution credits, and it does not require
managed execution or an execution-credit allowance. Server-wide Gateway,
OpenAI and scorer keys are not fallbacks for missing project credentials.

When Gateway reports `providerMetadata.gateway.cost`, that amount is recorded as
provider cost. Otherwise Datool records a configured estimate of $0.0045/minute
using `durationInSeconds`, with `cost_source=configured`. The rate comes from the
Gateway model catalog and must be reviewed when pricing changes. This cost is
separate from the agent's reply generation cost; the agent's daily reply budget
does not include transcription. Each audio request is bounded to five minutes.

A duplicate webhook or worker retry reuses the durable transcript and usage
record; it does not call the paid provider again. A definite provider rejection
records a failed attempt with zero cost. A timeout or missing duration records an
uncertain attempt with unknown cost and no automatic paid retry. The transcript
and successful usage cost are persisted atomically before delivery to the agent.

Existing checkpoints from the older managed-credit implementation are retained.
A retry of an already completed legacy transcription finishes its original
credit settlement without retranscribing. Uncertain legacy reservations still
require operator reconciliation; new project-funded attempts create no credit
operations.

Media failure sends a text request to continue by typing. The inbound ledger
retains a safe error code; no provider error body or secret is shown to customers.
Paused/human-owned conversations do not start media processing. Ownership and
worker lease are checked again before paid dispatch and before running the agent.

## Deployment and verification

Migration `0075_channel_media.sql` adds the transcription checkpoint table. The
production image includes FFmpeg. Configure Vercel AI Gateway in the project's
provider settings, exactly as for agent replies. No additional server key,
billing flag, credit grant or WhatsApp reconnection is required. The previous
OpenAI transcription key and managed Gateway setup scripts are not needed.

The worker calls the documented Gateway REST transcription endpoint with bounded
WAV audio encoded as base64 JSON. It does not use SDK retries or fall back to
another provider after an uncertain attempt. Transcription is in Gateway beta;
verify model access on the project's account. Usage identifies
`vercel-ai-gateway` and `openai/gpt-transcribe`. This change needs no new migration.

The Evolution integration test uses real PostgreSQL, FFmpeg and the worker, with
simulated Evolution/transcription HTTP responses. It covers image/caption
admission, OGG decoding, transcript delivery, project credential isolation,
usage attribution without credit charges, retries and provider failures. The
runtime test checks actual AI SDK image input and trace redaction. Neither test
establishes real provider availability or device-level delivery. After deployment,
send a new image and voice note from another number, verify replies and the usage
entry. Do not replay historical customer media automatically.

Provider contracts:

- [Evolution 2.3.7 media implementation](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts)
- [Gateway speech-to-text REST contract](https://vercel.com/docs/ai-gateway/modalities/speech-to-text)
- [Gateway model pricing catalog](https://ai-gateway.vercel.sh/v1/models)
