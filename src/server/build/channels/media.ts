import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import sharp from "sharp"
import type { ChannelImage } from "@/src/lib/build/channels"
import { executionCredits } from "@/src/server/execution-credits/ledger"
import { GATEWAY_PROVIDER } from "@/src/lib/model-providers"
import { getProjectProviderKey } from "@/src/server/model-providers/store"
import type { BuildContext } from "../context"
import { downloadEvolutionMedia } from "./evolution"

const run = promisify(execFile)
const MODEL = "openai/gpt-transcribe"
// Gateway /v1/models: transcription_duration_cost_per_second = $0.000075.
// Verified 2026-10-27; used only when the provider does not report a cost.
const NANO_PER_SECOND = 75_000
const MAX_SECONDS = 300
export class ChannelMediaError extends Error {
  constructor(readonly code: string) {
    super("This media message could not be processed.")
  }
}

async function audioFile(bytes: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "datool-audio-"))
  try {
    const source = join(directory, "source")
    const wav = join(directory, "audio.wav")
    await writeFile(source, bytes, { mode: 0o600 })
    // Decode locally to a bounded PCM file. This also handles WhatsApp Opus/OGG.
    // Never allow a playlist to fetch secondary files or network protocols.
    await run(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "ogg,mp3,mov,matroska,webm,wav,aac",
        "-i",
        source,
        "-t",
        "301",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      { timeout: 20_000, maxBuffer: 8192 }
    )
    const data = await readFile(wav)
    // RIFF chunk lengths include metadata, so derive duration from the data chunk.
    let offset = 12,
      pcmBytes = 0
    while (offset + 8 <= data.length) {
      const length = data.readUInt32LE(offset + 4)
      if (offset + 8 + length > data.length) break
      if (data.toString("ascii", offset, offset + 4) === "data") {
        pcmBytes = length
        break
      }
      offset += 8 + length + (length % 2)
    }
    const seconds = pcmBytes / 32_000
    if (!seconds || seconds > MAX_SECONDS || data.length > 10_000_000)
      throw new ChannelMediaError("AUDIO_LIMIT")
    return { data, seconds }
  } catch (error) {
    if (error instanceof ChannelMediaError) throw error
    throw new ChannelMediaError("AUDIO_INVALID")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function completeTranscript(
  context: BuildContext,
  messageId: string,
  row: Record<string, unknown>
) {
  // Finish only pre-upgrade managed-credit operations. New project-funded
  // transcriptions never reserve or settle organization credits.
  const usage = await context.database.execute<{
    credit_operation_id: string | null
  }>(sql`
    SELECT credit_operation_id FROM build_usage_event
    WHERE project_id=${context.projectId} AND event_key=${`transcription:${messageId}`}
  `)
  if (usage.rows[0]?.credit_operation_id) {
    const seconds = Number(row.seconds)
    const amount = Math.ceil(seconds * NANO_PER_SECOND)
    await executionCredits.settle(
      usage.rows[0].credit_operation_id,
      amount,
      row.provider_id == null ? null : String(row.provider_id),
      {
        model: "gpt-transcribe",
        seconds,
        channelMessageId: messageId,
        purpose: "audio_transcription",
      }
    )
    await context.database.execute(sql`
      UPDATE build_usage_event SET status='completed',cost_nano_usd=${amount},cost_source='provider',provider_log_id=${row.provider_id == null ? null : String(row.provider_id)}
      WHERE project_id=${context.projectId} AND credit_operation_id=${usage.rows[0].credit_operation_id}::uuid
    `)
  }
  await context.database.execute(sql`
    UPDATE build_channel_message SET content_json=jsonb_set(content_json,'{text}',${JSON.stringify(String(row.transcript))}::jsonb)
    WHERE project_id=${context.projectId} AND id=${messageId}
  `)
  return { text: String(row.transcript), images: [] as ChannelImage[] }
}

/** Called by the authenticated channel worker, after ownership/lease admission. */
export async function prepareEvolutionMedia(
  context: BuildContext,
  messageId: string,
  assertReady: () => Promise<void>
): Promise<{ text?: string; images: ChannelImage[] }> {
  await assertReady()
  const previous = await context.database.execute<Record<string, unknown>>(sql`
    SELECT * FROM build_channel_transcription WHERE project_id=${context.projectId} AND message_id=${messageId}
  `)
  if (previous.rows[0]) {
    if (previous.rows[0].state === "completed")
      return completeTranscript(context, messageId, previous.rows[0])
    throw new ChannelMediaError(
      String(previous.rows[0].error_code ?? "TRANSCRIPTION_UNCERTAIN")
    )
  }
  let media: Awaited<ReturnType<typeof downloadEvolutionMedia>>
  try {
    media = await downloadEvolutionMedia(context, messageId)
  } catch {
    throw new ChannelMediaError("MEDIA_UNAVAILABLE")
  }
  if (media.type === "image") {
    try {
      const data = await sharp(media.bytes, {
        limitInputPixels: 25_000_000,
        animated: false,
      })
        .rotate()
        .resize({
          width: 1600,
          height: 1600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer()
      return { images: [{ data, mediaType: "image/jpeg" }] as ChannelImage[] }
    } catch {
      throw new ChannelMediaError("IMAGE_INVALID")
    }
  }
  // Match agent replies: the project supplies its Gateway credential and pays
  // the provider directly. Missing project credentials never use server keys.
  let apiKey: string
  try {
    apiKey = await getProjectProviderKey(
      context.projectId,
      GATEWAY_PROVIDER,
      context.database
    )
  } catch {
    throw new ChannelMediaError("TRANSCRIPTION_NOT_CONFIGURED")
  }
  const audio = await audioFile(media.bytes)
  await assertReady()
  const operationId = randomUUID()
  // Atomically claim the paid attempt and its usage event. operation_id is also
  // the usage ID for new attempts; legacy rows retain their original credit ID.
  const claimed = await context.database.execute(sql`
    WITH attempt AS (
      INSERT INTO build_channel_transcription(message_id,project_id,operation_id,state)
      VALUES(${messageId},${context.projectId},${operationId}::uuid,'requested')
      ON CONFLICT DO NOTHING RETURNING operation_id
    )
    INSERT INTO build_usage_event(id,organization_id,project_id,agent_id,conversation_id,turn_id,event_key,kind,provider,model,status,cost_source)
    SELECT attempt.operation_id,p.organization_id,m.project_id,c.agent_id,c.id,${`channel-transcription:${messageId}`},${`transcription:${messageId}`},'model',${GATEWAY_PROVIDER},${MODEL},'pending','unknown'
    FROM attempt,build_channel_message m JOIN project p ON p.id=m.project_id JOIN build_conversations c ON c.id=m.conversation_id AND c.project_id=m.project_id
    WHERE m.project_id=${context.projectId} AND m.id=${messageId}
    RETURNING id
  `)
  if (!claimed.rows.length)
    throw new ChannelMediaError("TRANSCRIPTION_IN_PROGRESS")
  let resultPersisted = false
  try {
    try {
      await assertReady()
    } catch {
      await context.database.execute(
        sql`UPDATE build_channel_transcription SET state='failed',error_code='MEDIA_CANCELLED' WHERE project_id=${context.projectId} AND message_id=${messageId}`
      )
      await context.database.execute(
        sql`UPDATE build_usage_event SET status='blocked',cost_nano_usd=0,cost_source='provider' WHERE project_id=${context.projectId} AND id=${operationId}::uuid`
      )
      throw new ChannelMediaError("MEDIA_CANCELLED")
    }
    const response = await fetch(
      "https://ai-gateway.vercel.sh/v4/ai/transcription-model",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "ai-gateway-protocol-version": "0.0.1",
          "ai-transcription-model-specification-version": "4",
          "ai-model-id": MODEL,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio: audio.data.toString("base64"),
          mediaType: "audio/wav",
        }),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      }
    )
    const providerId = response.headers.get("x-request-id")
    await context.database.execute(sql`
      UPDATE build_usage_event SET provider_log_id=${providerId}
      WHERE project_id=${context.projectId} AND id=${operationId}::uuid
    `)
    if (
      [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(response.status)
    ) {
      await context.database.execute(
        sql`UPDATE build_channel_transcription SET state='failed',error_code='TRANSCRIPTION_REJECTED' WHERE project_id=${context.projectId} AND message_id=${messageId}`
      )
      await context.database.execute(
        sql`UPDATE build_usage_event SET status='failed',cost_nano_usd=0,cost_source='provider',provider_log_id=${providerId} WHERE project_id=${context.projectId} AND id=${operationId}::uuid`
      )
      throw new ChannelMediaError("TRANSCRIPTION_REJECTED")
    }
    if (!response.ok) throw new Error("Uncertain provider response")
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Missing response")
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 128_000) throw new Error("Response exceeded limit")
        chunks.push(value)
      }
    } finally {
      void reader.cancel().catch(() => {})
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    const seconds = result.durationInSeconds
    if (
      typeof result.text !== "string" ||
      result.text.length > 50_000 ||
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > MAX_SECONDS
    )
      throw new Error("Invalid measured usage")
    const transcript =
      result.text.trim() || "[Audio message without intelligible speech]"
    const reportedCost = result.providerMetadata?.gateway?.cost
    const hasReportedCost =
      typeof reportedCost === "number" &&
      Number.isFinite(reportedCost) &&
      reportedCost >= 0 &&
      reportedCost * 1_000_000_000 <= Number.MAX_SAFE_INTEGER
    const amount = hasReportedCost
      ? Math.ceil(reportedCost * 1_000_000_000)
      : Math.ceil(seconds * NANO_PER_SECOND)
    // Persist the transcript and its cost together. Recovery can then reuse both
    // without another provider call or a debit against organization credits.
    await context.database.execute(sql`
      WITH completed AS (
        UPDATE build_channel_transcription SET state='completed',transcript=${transcript},seconds=${seconds},provider_id=${providerId}
        WHERE project_id=${context.projectId} AND message_id=${messageId} RETURNING operation_id
      )
      UPDATE build_usage_event SET status='completed',cost_nano_usd=${amount},cost_source=${hasReportedCost ? "provider" : "configured"},provider_log_id=${providerId}
      FROM completed WHERE project_id=${context.projectId} AND id=completed.operation_id
    `)
    resultPersisted = true
    return await completeTranscript(context, messageId, {
      operation_id: operationId,
      seconds,
      provider_id: providerId,
      transcript,
    })
  } catch (error) {
    if (resultPersisted) throw error
    await context.database.execute(
      sql`UPDATE build_channel_transcription SET state='uncertain',error_code='TRANSCRIPTION_UNCERTAIN' WHERE project_id=${context.projectId} AND message_id=${messageId} AND state='requested'`
    )
    await context.database.execute(
      sql`UPDATE build_usage_event SET status='uncertain' WHERE project_id=${context.projectId} AND id=${operationId}::uuid AND status='pending'`
    )
    if (error instanceof ChannelMediaError) throw error
    throw new ChannelMediaError("TRANSCRIPTION_UNCERTAIN")
  }
}
