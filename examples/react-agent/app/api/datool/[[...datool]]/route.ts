import { createDatoolHandler } from "@datool/react/server"
import { demoAuth, options } from "../../../../lib/datool"

export const runtime = "nodejs"
export const POST = createDatoolHandler({
  ...options,
  config({ req }) {
    const { userId, drive } = demoAuth(req)
    return { userId, drive }
  },
})
