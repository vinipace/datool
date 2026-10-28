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
OGG/Opus voice notes. It is sent through the Datool-funded Vercel AI Gateway using
`openai/gpt-transcribe`; the resulting
text becomes the user message for the agent and appears in the channel ledger.
Temporary audio files are removed after decoding, and audio bytes are not stored
in PostgreSQL. The transcript follows conversation retention/deletion.

## Credits and retries

Transcription uses the existing organization execution-credit ledger, attributed
to the project, agent and conversation as a model operation. It requires managed
execution, an active paid allowance and sufficient available credits. The worker
reserves $0.0225 (the five-minute maximum) before the paid request, then settles
at $0.0045/minute using the Gateway's `durationInSeconds`. The rest is released.
The rate is pinned in code with a version and must be reviewed when pricing
changes. This is separate from the agent's model inference cost and daily budget.

A duplicate webhook or worker retry reuses the durable transcript and settlement;
it does not call the paid provider again. A definite provider rejection releases
the reservation. A timeout or missing usage leaves it reserved for operator
reconciliation, with no automatic paid retry. This favors no duplicate spending
over silently replaying an uncertain request. A crash after the reservation but
before dispatch may also require reconciliation. Completed results are stored
before settlement so a database recovery can finish billing without retranscribing.

Media failure sends a text request to continue by typing. The inbound ledger
retains a safe error code; no provider error body or secret is shown to customers.
Paused/human-owned conversations do not start media processing. Ownership and
worker lease are checked again before paid dispatch and before running the agent.

## Deployment and verification

Migration `0075_channel_media.sql` adds the transcription checkpoint table. The
production image includes FFmpeg. Configure the server-owned
`DATOOL_AI_GATEWAY_API_KEY`, or reuse the existing server `AI_GATEWAY_API_KEY`.
The dedicated Datool key takes precedence. Both require
`DATOOL_BILLING_ENABLED=true` and `DATOOL_MANAGED_EXECUTION_ENABLED=true`.
Project-owned provider keys and OpenAI/scorer keys are never used for paid
transcription. Existing OpenAI transcription configuration no longer enables it.
No WhatsApp reconnection is required.

The worker calls the documented Gateway REST transcription endpoint with bounded
WAV audio encoded as base64 JSON. It does not use SDK retries or fall back to
another provider after an uncertain attempt. Transcription is in Gateway beta;
verify model access on the Datool account before enabling production traffic.
The public Gateway model catalog currently reports $0.000075 per audio second
for `openai/gpt-transcribe`. Usage events identify `vercel-ai-gateway` and the
fully qualified model. The existing transcript checkpoints and credit records
are retained; this change requires no new migration.

The Evolution integration test uses real PostgreSQL, FFmpeg and the worker, with
simulated Evolution/transcription HTTP responses. It covers image/caption
admission, OGG decoding, transcript delivery, measured billing, retries, refunds,
uncertainty, insufficient credits and tenant/sender isolation. The runtime test
checks actual AI SDK image input and trace redaction. Neither test establishes
real provider availability or device-level delivery. After deployment, send a new
image and voice note from another number, verify replies, and check the usage
entry and credit delta. Do not replay historical customer media automatically.

Provider contracts:

- [Evolution 2.3.7 media implementation](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts)
- [Gateway speech-to-text REST contract](https://vercel.com/docs/ai-gateway/modalities/speech-to-text)
- [Gateway model pricing catalog](https://ai-gateway.vercel.sh/v1/models)
