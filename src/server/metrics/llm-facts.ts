import { sql, type SQL } from "drizzle-orm"
import { spans } from "@/src/server/tracer/schema"
import { recordedModelKeys } from "@/src/lib/tracer/usage"

export const recordedModelSql = sql`coalesce(${sql.join(
  recordedModelKeys.map(
    (key) =>
      sql`case when jsonb_typeof(${spans.attributesJson} -> ${key})='string' and (${spans.attributesJson} ->> ${key}) !~ '^[[:space:]]*$' then ${spans.attributesJson} ->> ${key} end`
  ),
  sql`, `
)})`
export const llmFactColumns = {
  costUsd: sql`${spans.costUsd}`,
  inputCostUsd: sql`${spans.inputCostUsd}`,
  outputCostUsd: sql`${spans.outputCostUsd}`,
  cacheCostUsd: sql`case when ${spans.cacheReadCostUsd} is not null or ${spans.cacheWriteCostUsd} is not null then coalesce(${spans.cacheReadCostUsd},0)+coalesce(${spans.cacheWriteCostUsd},0) end`,
  tokenCount: sql`coalesce(${spans.inputTokens}+${spans.outputTokens}, ${spans.reportedTotalTokens})`,
  inputTokens: sql`case when ${spans.inputTokens} is not null then greatest(0, ${spans.inputTokens}-coalesce(${spans.cachedTokens},0)-coalesce(${spans.writtenTokens},0)) end`,
  outputTokens: sql`${spans.outputTokens}`,
  cacheTokens: sql`case when ${spans.cachedTokens} is not null or ${spans.writtenTokens} is not null then coalesce(${spans.cachedTokens},0)+coalesce(${spans.writtenTokens},0) end`,
}
export const llmAggregates: Record<string, SQL> = {
  ...Object.fromEntries(
    Object.keys(llmFactColumns).map((k) => [k, sql`sum(${sql.identifier(k)})`])
  ),
  llmCount: sql`count(*) filter(where kind='llm')`,
  pricedLlmCount: sql`count("costUsd")`,
  unpricedLlmCount: sql`count(*) filter(where kind='llm' and "costUsd" is null)`,
  costCoverage: sql`count("costUsd")::double precision/nullif(count(*) filter(where kind='llm'),0)`,
  meanLlmCostUsd: sql`avg("costUsd")`,
}
