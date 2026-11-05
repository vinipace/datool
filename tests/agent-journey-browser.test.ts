import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { createServer } from "node:http"
import { widgetDefinitionSchema } from "@/src/lib/build/contracts"
import { JourneyBrowser } from "@/src/server/build/testing/journey-browser"

// Production-image acceptance uses this same shipped widget runtime and Chromium.
test("journey browser reports JSX failures and blocks widget requests to private services", async () => {
  let privateRequests = 0
  const server = createServer((_request, response) => {
    privateRequests++
    response.end("private")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const browser = new JourneyBrowser(390, AbortSignal.timeout(30_000), "pt-BR")
  try {
    await browser.open()
    await rejects(
      browser.show("", {
        definition: widgetDefinitionSchema.parse({
          name: "Broken picker",
          code: "const ChoiceGroup=()=>null;const ChoiceGroup=()=>null;export default function Widget(){return <ChoiceGroup/>}",
        }),
        data: {},
      }),
      /already been declared/
    )
    const definition = widgetDefinitionSchema.parse({
      name: "Network isolation",
      code: `import {useState,useEffect} from "react";
      export default function Widget(){const [status,setStatus]=useState("Loading");useEffect(()=>{fetch("http://127.0.0.1:${address.port}/private").then(()=>setStatus("Leaked"),()=>setStatus("Request blocked"))},[]);return <Text>{status}</Text>}`,
    })
    await browser.show("", { definition, data: {} })
    await browser.step({ type: "expect_text", text: "Request blocked" })
    expect(privateRequests).toBe(0)
    await browser.show("", {
      definition: widgetDefinitionSchema.parse({
        name: "Translated control",
        code: 'export default function Widget({t}){return <Text>{t("Choose a model")}</Text>}',
        translations: { "pt-BR": { "Choose a model": "Escolha um modelo" } },
      }),
      data: {},
    })
    await browser.step({ type: "expect_text", text: "Escolha um modelo" })
    await rejects(browser.step({ type: "expect_text", text: "Missing model" }))
  } finally {
    await browser.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}, 30_000)

test("queued journey browsers stop on cancellation without blocking the next case", async () => {
  const first = new JourneyBrowser(390, AbortSignal.timeout(30_000))
  const second = new JourneyBrowser(768, AbortSignal.timeout(30_000))
  const cancellation = new AbortController()
  const queued = new JourneyBrowser(390, cancellation.signal)
  try {
    await first.open()
    await second.open()
    const opening = queued.open()
    cancellation.abort()
    await rejects(opening, /cancelled/)
    await first.close()
    const replacement = new JourneyBrowser(390, AbortSignal.timeout(10_000))
    try {
      await replacement.open()
      await replacement.show("Still working")
      await replacement.step({ type: "expect_text", text: "Still working" })
    } finally {
      await replacement.close()
    }
  } finally {
    await first.close()
    await second.close()
    await queued.close()
  }
}, 30_000)
