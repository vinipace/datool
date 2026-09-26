// Served as JavaScript with a worker-specific CSP; never evaluated by the server.
export const columnWorkerSource = String.raw`
"use strict";
const reply = self.postMessage.bind(self);
self.onmessage = async ({ data }) => {
  try {
    const evaluate = new Function("row", '"use strict"; return (\n' + data.expression + '\n);');
    const value = await evaluate(data.row);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Expression returned a non-finite number; check for missing metrics");
    const text = value == null ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (text != null && text.length > 16000) throw new Error("Cell result exceeds 16,000 characters");
    reply({ value: text });
  } catch (error) {
    reply({ value: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
  }
};
reply({ ready: true });
`
