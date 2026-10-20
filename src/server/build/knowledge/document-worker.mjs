/**
 * Isolated document parser for Build knowledge sources.
 *
 * This file deliberately stays as a plain Node module. It is launched by the
 * parent worker with a small environment, a bounded stdin/stdout protocol and
 * a bounded V8 heap. PDF.js and Mammoth may process customer supplied bytes;
 * keeping those calls in a child means a parser failure cannot block the
 * indexing worker or the Next.js request process.
 */
import { Buffer } from "node:buffer"
import * as mammoth from "mammoth"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"

const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_CHARACTERS = 1_000_000
const MAX_PDF_PAGES = 500
const MAX_REQUEST_BYTES = Math.ceil(MAX_SOURCE_BYTES * 4 / 3) + 8_192
const MAX_RESPONSE_BYTES = MAX_TEXT_CHARACTERS * 6 + 16_384
const DEFAULT_DEADLINE_MS = 15_000

class DocumentParserError extends Error {}

function assertWithinDeadline(deadline) {
  if (Date.now() > deadline)
    throw new DocumentParserError("Document extraction exceeded its processing limit.")
}

function assertTextBounded(text) {
  if (text.length > MAX_TEXT_CHARACTERS)
    throw new DocumentParserError("The extracted document exceeds the character limit.")
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
}

async function extractPdf(bytes, deadline) {
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 5)) !== "%PDF-")
    throw new DocumentParserError("The uploaded file is not a PDF document.")

  let document
  let loadingTask
  try {
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      verbosity: pdfjs.VerbosityLevel.ERRORS,
      useWorkerFetch: false,
      useSystemFonts: true,
      disableFontFace: true,
      useWasm: false,
      stopAtErrors: true,
      maxImageSize: 0,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
    })
    document = await loadingTask.promise
    assertWithinDeadline(deadline)
    if (document.numPages > MAX_PDF_PAGES)
      throw new DocumentParserError(`The PDF exceeds the ${MAX_PDF_PAGES} page limit.`)

    const pages = []
    let extractedCharacters = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      assertWithinDeadline(deadline)
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent({ includeMarkedContent: false })
        assertWithinDeadline(deadline)
        const itemTexts = []
        for (const item of content.items) {
          const value = "str" in item ? item.str : ""
          if (!value) continue
          extractedCharacters += value.length + (itemTexts.length ? 1 : 0)
          if (extractedCharacters > MAX_TEXT_CHARACTERS)
            throw new DocumentParserError("The extracted document exceeds the character limit.")
          itemTexts.push(value)
        }
        if (itemTexts.length) pages.push(itemTexts.join(" "))
      } finally {
        page.cleanup()
      }
    }

    const text = normalizeText(pages.join("\n\n"))
    assertTextBounded(text)
    if (!text)
      throw new DocumentParserError(
        "This PDF has no extractable text. Scanned PDFs require OCR before indexing."
      )
    return text
  } catch (error) {
    if (error instanceof DocumentParserError) throw error
    throw new DocumentParserError("PDF text extraction failed.")
  } finally {
    try {
      await document?.cleanup()
      await loadingTask?.destroy()
    } catch {
      // Cleanup must not mask the parser result.
    }
  }
}

async function extractDocx(bytes, deadline) {
  assertWithinDeadline(deadline)
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
    assertWithinDeadline(deadline)
    const text = normalizeText(result.value)
    assertTextBounded(text)
    if (!text)
      throw new DocumentParserError("The DOCX document has no extractable text.")
    return text
  } catch (error) {
    if (error instanceof DocumentParserError) throw error
    throw new DocumentParserError("DOCX text extraction failed.")
  }
}

async function readRequest() {
  const chunks = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > MAX_REQUEST_BYTES)
      throw new DocumentParserError("The parser request exceeds its byte limit.")
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8"))
}

function writeResponse(payload) {
  const output = Buffer.from(JSON.stringify(payload), "utf8")
  if (output.byteLength > MAX_RESPONSE_BYTES)
    return process.stdout.write(
      JSON.stringify({ ok: false, error: "The parser response exceeds its byte limit." })
    )
  process.stdout.write(output)
}

async function main() {
  try {
    const request = await readRequest()
    if (!request || (request.kind !== "pdf" && request.kind !== "docx"))
      throw new DocumentParserError("Unsupported parser request.")
    if (typeof request.bytesBase64 !== "string" || !request.bytesBase64)
      throw new DocumentParserError("The parser request has no document bytes.")

    const bytes = Buffer.from(request.bytesBase64, "base64")
    if (bytes.byteLength > MAX_SOURCE_BYTES)
      throw new DocumentParserError("The source exceeds its byte limit.")
    const requestedDeadline = Number(request.maxProcessingMs)
    const deadline = Date.now() + (
      Number.isFinite(requestedDeadline) && requestedDeadline > 0
        ? Math.min(requestedDeadline, DEFAULT_DEADLINE_MS)
        : DEFAULT_DEADLINE_MS
    )
    const text = request.kind === "pdf"
      ? await extractPdf(bytes, deadline)
      : await extractDocx(bytes, deadline)
    writeResponse({ ok: true, text })
  } catch (error) {
    writeResponse({
      ok: false,
      error: error instanceof DocumentParserError ? error.message : "Document parser failed.",
    })
  }
}

await main()
