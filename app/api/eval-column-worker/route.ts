import { columnWorkerSource } from "@/src/lib/tracer/column-worker-source"

export function GET() {
  return new Response(columnWorkerSource, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
      "Cache-Control": "no-store",
    },
  })
}
