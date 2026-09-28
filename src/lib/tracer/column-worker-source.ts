// Served as JavaScript with a worker-specific CSP; never evaluated by the server.
export const columnWorkerSource = String.raw`
"use strict";
const reply = self.postMessage.bind(self);
self.onmessage = async ({ data }) => {
  try {
    const evaluate = new Function("row", '"use strict"; return (\n' + data.expression + '\n);');
    const value = await evaluate(data.row);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Expression returned a non-finite number; check for missing metrics");
    const text = value === undefined ? null : JSON.stringify(value);
    if (value !== undefined && text === undefined) throw new Error("Field values must be JSON serializable");
    if (text != null && text.length > 16000) throw new Error("Cell result exceeds 16,000 characters");
    const type = Array.isArray(value) ? "array" : typeof value;
    if (value != null && data.resultType && data.resultType !== "any" && type !== data.resultType) throw new Error("Field result does not match its declared type");
    reply({ value: text == null ? null : JSON.parse(text), missing: value === undefined });
  } catch (error) {
    reply({ value: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
  }
};
reply({ ready: true });
`
