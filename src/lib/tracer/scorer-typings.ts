/** Type-only module available inside Monaco; no runtime imports are needed. */
export const scorerDeclarations = `
declare module "datool/scorer" {
  export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
  export type JsonObject = { [key: string]: JsonValue | undefined };
  export type Status = "cancelled" | "completed" | "errored" | "running";
  export interface Span {
    id: string; traceId: string; parentId: string | null; name: string;
    kind: "agent" | "custom" | "function" | "llm" | "score" | "task" | "tool" | "workflow";
    status: Status; startedAt: string; endedAt: string | null; durationMs: number | null;
    input: JsonValue; output: JsonValue; attributes: JsonObject;
  }
  export interface Trace {
    selectedSpanId?: string;
    provenance?: { trace: { id: string; startedAt: string; endedAt: string | null; attributes: JsonObject }; ancestors: Pick<Span, "id" | "parentId" | "name" | "kind" | "startedAt" | "endedAt" | "attributes">[] };
    id: string; name: string; operation: string; sessionId: string | null;
    status: Status; startedAt: string; endedAt: string | null;
    input: JsonValue; output: JsonValue; attributes: JsonObject; spans: Span[]; linkedTraces?: Trace[];
  }
  export interface DatasetItem {
    sourceSpanId?: string | null; sourceSpanEvidence?: Trace | null; observedOutput?: JsonValue;
    id: string; datasetId: string; sourceTraceId: string | null;
    input: JsonValue; expectedOutput: JsonValue; metadata: JsonObject;
  }
  export interface ScorerInput {
    trace: Trace;
    datasetItem?: DatasetItem | null;
  }
  export interface ScorerResult {
    /** A finite score between 0 and 1. */
    score: number;
    passed?: boolean;
    label?: string;
    /** Brief explanation, stored with the result. */
    reason?: string;
    metrics?: JsonObject;
  }
}
`

/** Comments are valid in the existing JavaScript sandbox and persist on save. */
export function withScorerTypes(code: string): string {
  if (/@(?:param|type)\b/.test(code)) return code
  return code.replace(
    /^(\s*)((?:async\s+)?function\s+evaluate\s*\()/m,
    '$1/**\n * @param {import("datool/scorer").ScorerInput} args\n * @returns {import("datool/scorer").ScorerResult | Promise<import("datool/scorer").ScorerResult>}\n */\n$2'
  )
}
