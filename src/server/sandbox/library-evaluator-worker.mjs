// Curated package execution only: no user code, package names, URLs or credentials.
import { createInterface } from "node:readline"
import { createRequire } from "node:module"
import {
  ExactMatch,
  Levenshtein,
  NumericDiff,
  ValidJSON,
  JSONDiff,
  Factuality,
} from "autoevals"

const evaluators = {
  ExactMatch,
  Levenshtein,
  NumericDiff,
  ValidJSON,
  JSONDiff,
  Factuality,
}
const version = createRequire(import.meta.url)("autoevals/package.json").version
const pending = new Map()
let sequence = 0
let started = false
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const request = (endpoint, body) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    write({ type: "request", id, endpoint, body })
  })
const client = {
  chat: {
    completions: { create: (body) => request("chat/completions", body) },
  },
  responses: { create: (body) => request("responses", body) },
}
const lines = createInterface({ input: process.stdin })
lines.on("line", async (line) => {
  try {
    const message = JSON.parse(line)
    if (started) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) call?.reject(new Error("Provider request failed"))
      else call?.resolve(message.body)
      return
    }
    started = true
    const { evaluator, args, options, model, useCoT, useResponsesApi } = message
    if (version !== "0.3.0" || !Object.hasOwn(evaluators, evaluator))
      throw new Error("Unsupported evaluator")
    const result = await evaluators[evaluator]({
      ...args,
      ...options,
      ...(evaluator === "Factuality"
        ? { client, model, useCoT, useResponsesApi }
        : {}),
    })
    write({ type: "result", result })
  } catch {
    // SDK errors can include request bodies. Never send those through the protocol.
    write({ type: "error" })
  }
})
