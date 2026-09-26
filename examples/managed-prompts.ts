// Run with DATOOL_BASE_URL/API_KEY/PROJECT_ID set.
// Usage: bun run examples/managed-prompts.ts brand-extraction '{"text":"Example"}'
// In an installed application, import from "@datool/sdk" instead.
import { createDatool } from "../packages/sdk/src/index"
const datool = createDatool()
const prompt = await datool.prompts.get(process.argv[2] ?? "brand-extraction")
console.log({
  id: prompt.id,
  version: prompt.version,
  model: prompt.model,
  messages: prompt.render(JSON.parse(process.argv[3] ?? "{}")),
  settings: prompt.settings,
})
