import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import {
  RequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js"
import { OpenAIMessageParamsSchema } from "@openai/mcp-extensions/app"
import { z } from "zod"

const frame = document.querySelector<HTMLIFrameElement>("#app")!
const state = document.querySelector<HTMLPreElement>("#received")!
const standard = new URL(location.href).searchParams.has("standard")
const bare = new URL(location.href).searchParams.has("bare")
const bridge = new AppBridge(
  null,
  { name: "Datool fixture host", version: "1" },
  {
    serverTools: {},
    ...(!bare
      ? {
          message: { text: {} },
          updateModelContext: { text: {}, structuredContent: {} },
        }
      : {}),
    ...(!bare && !standard
      ? { experimental: { "openai/modelContext": {}, "openai/message": {} } }
      : {}),
  },
  { hostContext: { theme: "dark", displayMode: "fullscreen" } }
)
let counter = 0
let failNext = false
let delayNext = false
async function call(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  counter++
  document.querySelector("#calls")!.textContent =
    `Server calls: ${counter} · ${name}`
  if (delayNext) {
    delayNext = false
    await new Promise((resolve) => setTimeout(resolve, 6000))
  }
  if (failNext) {
    failNext = false
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Fixture: temporary read failure. Retry is safe.",
        },
      ],
    }
  }
  const response = await fetch("/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: counter,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  return (await response.json()).result
}
bridge.oncalltool = ({ name, arguments: args }) => call(name, args ?? {})
bridge.onupdatemodelcontext = async (params) => {
  state.textContent = JSON.stringify(
    { received: "context", ...params },
    null,
    2
  )
  const updateId = `fixture-${Date.now()}`
  bridge.setHostContext({
    theme: "dark",
    displayMode: "fullscreen",
    "openai/modelContext": { ...params, updateId },
  })
  return { _meta: { "openai/modelContext": { updateId } } }
}
// A supporting host must retain the extension metadata when parsing ui/message.
if (!bare && !standard)
  bridge.setRequestHandler(
    RequestSchema.extend({
      method: z.literal("ui/message"),
      params: OpenAIMessageParamsSchema,
    }),
    async ({ params }) => {
      state.textContent = JSON.stringify(
        { received: "message", ...params },
        null,
        2
      )
      return {}
    }
  )
else
  bridge.onmessage = async (params) => {
    state.textContent = JSON.stringify(
      { received: "message", ...params },
      null,
      2
    )
    return {}
  }
bridge.oninitialized = () => {
  void bridge
    .sendToolInput({ arguments: {} })
    .then(async () =>
      bridge.sendToolResult(await call("open_trace_explorer", {}))
    )
}
document.querySelector("#empty")!.addEventListener("click", () => {
  void call("open_trace_explorer", { filter: 'name = "no matches"' }).then(
    (result) => bridge.sendToolResult(result)
  )
})
document.querySelector("#reset")!.addEventListener("click", () => {
  void call("open_trace_explorer", {}).then((result) =>
    bridge.sendToolResult(result)
  )
})
document.querySelector("#fail")!.addEventListener("click", () => {
  failNext = true
})
document.querySelector("#delay")!.addEventListener("click", () => {
  delayNext = true
})
await bridge.connect(
  new PostMessageTransport(frame.contentWindow!, frame.contentWindow!)
)
frame.src = "/app.html"
