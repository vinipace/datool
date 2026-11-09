import { DatoolError } from "@datool/sdk/agents"
import { agentFor, demoAuth, workspaces } from "../../../lib/datool"

export const runtime = "nodejs"
const path = "context/company.md"
export async function GET(req: Request) {
  try {
    const auth = demoAuth(req)
    const agent = agentFor(req)
    const tasks = await agent.tasks.list()
    return Response.json(
      {
        workspace: auth.orgId,
        workspaceName: workspaces[auth.orgId],
        tasks: tasks.items,
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return failure(error)
  }
}
export async function POST(req: Request) {
  const origin = req.headers.get("origin")
  if (origin && origin !== new URL(req.url).origin)
    return Response.json({ error: "Invalid origin." }, { status: 403 })
  try {
    demoAuth(req)
    const input = await req.json()
    if (input.action === "workspace") {
      if (!(input.workspace === "acme" || input.workspace === "orbit"))
        throw new Error("Unknown demo workspace.")
      return Response.json(
        { ok: true },
        {
          headers: {
            "Set-Cookie": `datool_demo_workspace=${input.workspace}; Path=/; HttpOnly; SameSite=Lax`,
          },
        }
      )
    }
    const agent = agentFor(req)
    if (input.action === "save") {
      if (typeof input.content !== "string" || input.content.length > 20_000)
        throw new Error("Use up to 20,000 characters.")
      await agent.files.write(path, input.content)
      return Response.json({ message: "Context saved to your drive." })
    }
    if (input.action === "read")
      return Response.json({
        content: await agent.files.read(path),
        message: "Context loaded from your drive.",
      })
    if (input.action === "list")
      return Response.json({ files: await agent.files.list("context") })
    if (input.action === "briefing") {
      const delay = input.schedule === "minute"
      const task = await agent.tasks.create({
        name: delay ? "Briefing in one minute" : "Weekday morning briefing",
        prompt:
          "Read /workspace/context/company.md and send a concise, useful briefing with three next steps. Mention if the context file is missing. Do not call external systems.",
        schedule: delay
          ? { kind: "once", at: new Date(Date.now() + 60_000).toISOString() }
          : { kind: "cron", expression: "0 9 * * 1-5" },
        timezone: "America/Sao_Paulo",
      })
      return Response.json({
        task,
        message: delay
          ? "Scheduled. Keep the chat open to see the reply arrive."
          : "Scheduled for weekdays at 9:00 AM São Paulo time.",
      })
    }
    if (["pause", "resume", "delete", "run"].includes(input.action)) {
      const current = (await agent.tasks.list()).items.find(
        (task) => task.id === input.id
      )
      if (!current) throw new Error("This task is not in your workspace.")
      if (input.action === "run") await agent.tasks.runNow(current.id)
      else if (input.action === "pause") await agent.tasks.pause(current)
      else if (input.action === "resume") await agent.tasks.resume(current)
      else await agent.tasks.delete(current)
      return Response.json({
        message:
          input.action === "run"
            ? "Queued. The reply will appear in chat."
            : "Task updated.",
      })
    }
    return Response.json({ error: "Unknown action." }, { status: 400 })
  } catch (error) {
    return failure(error)
  }
}
function failure(error: unknown) {
  return Response.json(
    { error: error instanceof Error ? error.message : "Something went wrong." },
    { status: error instanceof DatoolError ? error.status : 400 }
  )
}
