/** Bounded, sequential capability RPC over sandbox stdio. No host credentials or sockets enter user code. */
export async function sandboxRpc(
  stdout: AsyncIterable<Uint8Array | string>,
  write: (text: string) => Promise<void>,
  invoke: (request: unknown) => Promise<unknown>,
  result: (text: string) => void
) {
  let pending = "",
    calls = 0,
    finished = false,
    total = 0
  const decoder = new TextDecoder()
  for await (const bytes of stdout) {
    total +=
      typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength
    if (total > 8 * 1024 * 1024)
      throw new Error("Sandbox protocol output exceeded its limit.")
    pending +=
      typeof bytes === "string"
        ? bytes
        : decoder.decode(bytes, { stream: true })
    if (Buffer.byteLength(pending) > 2 * 1024 * 1024)
      throw new Error("Sandbox message exceeded its limit.")
    let end: number
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (!line) continue
      if (finished) throw new Error("Sandbox sent output after completing.")
      const message = JSON.parse(line)
      if (message.type === "result") {
        finished = true
        result(JSON.stringify(message))
      } else if (message.type === "rpc" && Number.isSafeInteger(message.id)) {
        if (++calls > 100)
          throw new Error("Sandbox exceeded 100 capability calls.")
        let response
        try {
          response = { id: message.id, value: await invoke(message.request) }
        } catch (error) {
          response = {
            id: message.id,
            error:
              error instanceof Error
                ? error.message
                : "Capability request failed.",
          }
        }
        const serialized = JSON.stringify(response)
        if (Buffer.byteLength(serialized) > 2 * 1024 * 1024)
          throw new Error("Capability response exceeded its limit.")
        await write(serialized + "\n")
      } else throw new Error("Invalid sandbox protocol message.")
    }
  }
  if (!finished || pending.trim())
    throw new Error("Sandbox stopped before returning a result.")
}

/** Consume provider Web Streams directly; Node adapters can emit unhandled errors on abort. */
export async function* sandboxStream<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader()
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) return
      yield item.value
    }
  } finally {
    reader.releaseLock()
  }
}
