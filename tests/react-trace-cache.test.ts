import { expect, test } from "bun:test"
import { prepareTraceView } from "@/src/lib/tracer/trace-view-client"

test("compilation is deduplicated, cached across traces, and usable when storage is unavailable", async () => {
  const previous = Object.fromEntries(["fetch", "localStorage", "Worker"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let workers = 0
  let terminated = 0
  const artifacts = new Map<string, string>()
  class WorkerStub {
    onmessage?: (event: {data: unknown}) => void
    onerror?: () => void
    constructor() { workers++ }
    postMessage({source, format}: {source: string; format: string}) {
      queueMicrotask(() => this.onmessage?.({data: {artifact: {source, format, buildId:"cache-test", javascript:"", css:"", modules:[]}}}))
    }
    terminate() { terminated++ }
  }
  try {
    Object.defineProperty(globalThis, "fetch", {configurable:true, value: async () => new Response(JSON.stringify({buildId:"cache-test"}))})
    Object.defineProperty(globalThis, "localStorage", {configurable:true, value:{getItem:(key:string)=>artifacts.get(key)??null, setItem:()=>{throw new Error("Storage quota exceeded")}}})
    Object.defineProperty(globalThis, "Worker", {configurable:true, value:WorkerStub})
    const [first, second] = await Promise.all([prepareTraceView("first"), prepareTraceView("first")])
    expect(first).toBe(second)
    expect(workers).toBe(1)
    expect(await prepareTraceView("first")).toBe(first)
    expect(workers).toBe(1)
    await prepareTraceView("changed code")
    expect(workers).toBe(2)
    expect(terminated).toBe(2)
    const mdx = await prepareTraceView("first", "mdx")
    expect(mdx.format).toBe("mdx")
    expect(mdx).not.toBe(first)
    expect(await prepareTraceView("first")).toBe(first)
    expect(await prepareTraceView("first", "mdx")).toBe(mdx)
    expect(workers).toBe(3)
    expect(terminated).toBe(3)
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
