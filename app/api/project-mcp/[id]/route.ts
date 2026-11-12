import { handleProjectMcp, projectMcpOptions } from "@/src/server/deploy/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleProjectMcp(request, (await params).id)
}
export const GET = POST
export const OPTIONS = projectMcpOptions
