import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { join } from "node:path"

import {
  KNOWLEDGE_LIMITS,
  normalizeKnowledgeText,
  type KnowledgeQaPair,
} from "@/src/lib/build/knowledge"

export type ExtractedDocument = {
  text: string
  mimeType: string
  metadata?: Record<string, unknown>
}

export class KnowledgeExtractionError extends Error {
  readonly code = "KNOWLEDGE_EXTRACTION_FAILED"
}

function assertBoundedBytes(bytes: Uint8Array) {
  if (bytes.byteLength > KNOWLEDGE_LIMITS.maxSourceBytes)
    throw new KnowledgeExtractionError(
      `The source exceeds the ${KNOWLEDGE_LIMITS.maxSourceBytes} byte limit.`
    )
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

function assertExtractedTextBounded(text: string) {
  if (text.length > KNOWLEDGE_LIMITS.maxTextCharacters)
    throw new KnowledgeExtractionError(
      `The extracted document exceeds the ${KNOWLEDGE_LIMITS.maxTextCharacters} character limit.`
    )
}

function extractionDeadline() {
  return Date.now() + KNOWLEDGE_LIMITS.maxDocumentExtractionMs
}

function assertWithinExtractionDeadline(deadline: number) {
  if (Date.now() > deadline)
    throw new KnowledgeExtractionError(
      `Document extraction exceeded the ${KNOWLEDGE_LIMITS.maxDocumentExtractionMs}ms processing limit.`
    )
}

/**
 * DOCX is a ZIP container. Mammoth correctly handles OOXML parsing, but a
 * compressed archive can expand far beyond the uploaded byte limit before the
 * parser returns. Inspect the central directory first and reject encrypted,
 * ZIP64, oversized, or excessively fragmented archives. The byte limits are
 * conservative enough for normal customer documents and keep extraction
 * bounded without replacing Mammoth's maintained parser.
 */
function assertBoundedDocxArchive(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minimumEnd = Math.max(0, bytes.byteLength - 65_557)
  let endOfCentralDirectory = -1
  for (let offset = bytes.byteLength - 22; offset >= minimumEnd; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOfCentralDirectory = offset
      break
    }
  }
  if (endOfCentralDirectory < 0)
    throw new KnowledgeExtractionError("The DOCX archive is malformed.")
  const entries = view.getUint16(endOfCentralDirectory + 10, true)
  const centralDirectorySize = view.getUint32(endOfCentralDirectory + 12, true)
  const centralDirectoryOffset = view.getUint32(
    endOfCentralDirectory + 16,
    true
  )
  if (
    entries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  )
    throw new KnowledgeExtractionError(
      "ZIP64 DOCX archives are not supported by the bounded extractor."
    )
  if (entries > KNOWLEDGE_LIMITS.maxArchiveEntries)
    throw new KnowledgeExtractionError("The DOCX archive has too many entries.")
  const directoryEnd = centralDirectoryOffset + centralDirectorySize
  if (
    centralDirectoryOffset > bytes.byteLength ||
    centralDirectorySize > bytes.byteLength ||
    directoryEnd > bytes.byteLength
  )
    throw new KnowledgeExtractionError("The DOCX archive is malformed.")

  let offset = centralDirectoryOffset
  let totalUncompressed = 0
  for (let index = 0; index < entries; index++) {
    if (
      offset + 46 > directoryEnd ||
      view.getUint32(offset, true) !== 0x02014b50
    )
      throw new KnowledgeExtractionError("The DOCX archive is malformed.")
    const flags = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const fileNameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (flags & 0x1)
      throw new KnowledgeExtractionError(
        "Encrypted DOCX archives are not supported."
      )
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      throw new KnowledgeExtractionError(
        "ZIP64 DOCX archives are not supported by the bounded extractor."
      )
    totalUncompressed += uncompressedSize
    if (totalUncompressed > KNOWLEDGE_LIMITS.maxArchiveUncompressedBytes)
      throw new KnowledgeExtractionError(
        "The DOCX archive expands beyond the configured extraction limit."
      )
    offset += 46 + fileNameLength + extraLength + commentLength
  }
  if (offset !== directoryEnd)
    throw new KnowledgeExtractionError("The DOCX archive is malformed.")
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => {
      const number = Number.parseInt(value, 16)
      return Number.isSafeInteger(number) && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : ""
    })
    .replace(/&#(\d+);/g, (_, value: string) => {
      const number = Number.parseInt(value, 10)
      return Number.isSafeInteger(number) && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : ""
    })
}

export function extractHtmlText(html: string) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(
      /<(?:nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside|form)>/gi,
      " "
    )
    .replace(
      /<[^>]+role=["'](?:navigation|banner|contentinfo|complementary)["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
      " "
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(?:p|div|section|article|li|h[1-6]|tr|td|th|pre|blockquote)>/gi,
      "\n"
    )
    .replace(/<[^>]+>/g, " ")
  const text = normalizeKnowledgeText(decodeHtmlEntities(withoutNoise))
  return {
    text,
    title: title
      ? normalizeKnowledgeText(decodeHtmlEntities(title))
      : undefined,
  }
}

// Keep this path independent of Next's bundled module location. The release
// includes this plain Node entrypoint alongside the application sources.
const documentParserWorkerPath = join(
  process.cwd(),
  "src/server/build/knowledge/document-worker.mjs"
)
const maxParserRequestBytes = Math.ceil(
  KNOWLEDGE_LIMITS.maxSourceBytes * 4 / 3
) + 8_192
const maxParserResponseBytes = KNOWLEDGE_LIMITS.maxTextCharacters * 6 + 16_384

function parserNodeExecutable() {
  const configured = process.env.DATOOL_NODE_PATH?.trim()
  if (configured) return configured
  // Bun exposes a Node compatibility version but its executable cannot run
  // the worker with Node's memory flags. Production runs under Node directly;
  // local Bun workers resolve the real Node binary through the minimal PATH.
  return process.versions.bun ? "node" : process.execPath
}

function parserEnvironment() {
  // Do not inherit API keys, database URLs, proxy credentials or NODE_OPTIONS.
  // PATH is the only variable needed to resolve Node when the parent is Bun.
  return {
    PATH:
      process.env.PATH ??
      "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  }
}

async function runDocumentParser(
  kind: "pdf" | "docx",
  bytes: Uint8Array,
  deadline: number
) {
  assertWithinExtractionDeadline(deadline)
  const request = JSON.stringify({
    kind,
    bytesBase64: Buffer.from(bytes).toString("base64"),
    maxProcessingMs: Math.max(1, deadline - Date.now()),
  })
  if (Buffer.byteLength(request, "utf8") > maxParserRequestBytes)
    throw new KnowledgeExtractionError(
      "The document parser request exceeds its byte limit."
    )

  const timeoutMs = Math.max(1, deadline - Date.now())
  return await new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        parserNodeExecutable(),
        ["--max-old-space-size=256", documentParserWorkerPath],
        {
          cwd: process.cwd(),
          env: parserEnvironment() as unknown as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        }
      )
    } catch {
      reject(new KnowledgeExtractionError("The document parser could not start."))
      return
    }

    let settled = false
    let outputBytes = 0
    const output: Buffer[] = []
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(
        new KnowledgeExtractionError(
          `Document extraction exceeded the ${KNOWLEDGE_LIMITS.maxDocumentExtractionMs}ms processing limit.`
        )
      )
    }, timeoutMs)

    const fail = (error: KnowledgeExtractionError) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill("SIGKILL")
      reject(error)
    }

    child.once("error", () => {
      fail(new KnowledgeExtractionError("The document parser could not start."))
    })
    const stdout = child.stdout
    const stdin = child.stdin
    if (!stdout || !stdin) {
      fail(new KnowledgeExtractionError("The document parser streams could not start."))
      return
    }
    stdout.on("data", (chunk: Buffer | Uint8Array | string) => {
      const bytesRead = Buffer.byteLength(chunk)
      outputBytes += bytesRead
      if (outputBytes > maxParserResponseBytes) {
        fail(new KnowledgeExtractionError("The document parser response exceeds its byte limit."))
        return
      }
      output.push(Buffer.from(chunk))
    })
    child.once("close", (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (exitCode !== 0) {
        reject(new KnowledgeExtractionError("The document parser failed."))
        return
      }
      try {
        const result = JSON.parse(Buffer.concat(output).toString("utf8")) as {
          ok?: boolean
          text?: unknown
          error?: unknown
        }
        if (!result.ok || typeof result.text !== "string") {
          const message =
            typeof result.error === "string"
              ? result.error
              : "The document parser failed."
          reject(new KnowledgeExtractionError(message))
          return
        }
        resolve(result.text)
      } catch {
        reject(new KnowledgeExtractionError("The document parser returned invalid output."))
      }
    })

    stdin.once("error", () => {
      fail(new KnowledgeExtractionError("The document parser input failed."))
    })
    stdin.end(request)
  })
}

/**
 * PDF.js handles compressed content streams, character maps and layout text
 * items. We deliberately do not OCR image-only documents; callers receive a
 * typed extraction error rather than indexing an empty or misleading source.
 */
export async function extractPdfText(bytes: Uint8Array) {
  assertBoundedBytes(bytes)
  const deadline = extractionDeadline()
  const header = new TextDecoder("latin1").decode(bytes.slice(0, 5))
  if (!header.startsWith("%PDF-"))
    throw new KnowledgeExtractionError(
      "The uploaded file is not a PDF document."
    )
  try {
    const text = normalizeKnowledgeText(
      await runDocumentParser("pdf", bytes, deadline)
    )
    assertExtractedTextBounded(text)
    if (!text)
      throw new KnowledgeExtractionError(
        "This PDF has no extractable text. Scanned PDFs require OCR before indexing."
      )
    return text
  } catch (error) {
    if (error instanceof KnowledgeExtractionError) throw error
    throw new KnowledgeExtractionError("PDF text extraction failed.")
  }
}

/** DOCX is parsed through Mammoth so ZIP/XML edge cases stay in a maintained parser. */
export async function extractDocxText(bytes: Uint8Array) {
  assertBoundedBytes(bytes)
  const deadline = extractionDeadline()
  try {
    assertBoundedDocxArchive(bytes)
    assertWithinExtractionDeadline(deadline)
    const text = normalizeKnowledgeText(
      await runDocumentParser("docx", bytes, deadline)
    )
    assertExtractedTextBounded(text)
    if (!text)
      throw new KnowledgeExtractionError(
        "The DOCX document has no extractable text."
      )
    return text
  } catch (error) {
    if (error instanceof KnowledgeExtractionError) throw error
    throw new KnowledgeExtractionError("DOCX text extraction failed.")
  }
}

export async function extractDocumentText(options: {
  fileName: string
  mimeType?: string
  bytes: Uint8Array
}): Promise<ExtractedDocument> {
  assertBoundedBytes(options.bytes)
  const fileName = options.fileName.toLowerCase()
  const mimeType = (options.mimeType ?? "").toLowerCase()
  if (mimeType.includes("pdf") || fileName.endsWith(".pdf"))
    return {
      text: await extractPdfText(options.bytes),
      mimeType: "application/pdf",
    }
  if (
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("docx") ||
    fileName.endsWith(".docx")
  )
    return {
      text: await extractDocxText(options.bytes),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
  if (
    mimeType.startsWith("text/") ||
    mimeType.includes("markdown") ||
    mimeType.includes("csv") ||
    /\.(?:txt|md|markdown|csv|json|xml|html?)$/i.test(fileName)
  )
    return (() => {
      const text = normalizeKnowledgeText(decodeUtf8(options.bytes))
      assertExtractedTextBounded(text)
      return { text, mimeType: mimeType || "text/plain" }
    })()
  throw new KnowledgeExtractionError(
    "Unsupported file type. Upload TXT, Markdown, CSV, JSON, HTML, PDF, or DOCX."
  )
}

export function qaPairsToText(pairs: readonly KnowledgeQaPair[]) {
  return normalizeKnowledgeText(
    pairs
      .map((pair) => `Question: ${pair.question}\nAnswer: ${pair.answer}`)
      .join("\n\n")
  )
}
