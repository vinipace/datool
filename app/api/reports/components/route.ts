import { api } from "@/src/server/tracer/http"
import { tracerEffect } from "@/src/server/tracer/effect"
import { reportComponentsCatalog } from "@/src/lib/tracer/report-mdx"
export const dynamic = "force-dynamic"
export async function GET(request:Request) {return api(request,()=>tracerEffect(async()=>reportComponentsCatalog()))}
