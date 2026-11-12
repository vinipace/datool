/** This program runs only inside a provider sandbox; interpolate no user code into its command. */
export const deploymentRunner = String.raw`
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
let start, nextId = 0;
const pending = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const rpc = (op, input) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); send({ type: 'rpc', id, request: { op, input } });
});
const context = {
  query: (sql, params, method) => rpc('sql.query', { sql, params, method }),
  db: {
    get: (collection, key) => rpc('db.get', { collection, key }),
    set: (collection, key, value, expectedRevision) => rpc('db.set', { collection, key, value, expectedRevision }),
    delete: (collection, key, expectedRevision) => rpc('db.delete', { collection, key, expectedRevision }),
    list: (collection, options = {}) => rpc('db.list', { collection, ...options }),
  },
  bucket: {
    get: async key => { const item = await rpc('bucket.get', { key }); return item && { ...item, data: Buffer.from(item.data, 'base64') }; },
    put: (key, data, contentType = 'application/octet-stream') => rpc('bucket.put', { key, data: Buffer.from(data).toString('base64'), contentType }),
    delete: key => rpc('bucket.delete', { key }),
    list: (options = {}) => rpc('bucket.list', options),
  },
  sandbox: { run: (command, options = {}) => rpc('sandbox.run', { command, ...options }) },
  brain: { search: (query, limit) => rpc('brain.search', { query, limit }) },
  fetch: async (url, options = {}) => {
    const response = await rpc('fetch', { url, ...options });
    return new Response([204,205,304].includes(response.status) || options.method === 'HEAD' ? null : Buffer.from(response.body, 'base64'), { status: response.status, headers: response.headers });
  },
};
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
async function run(packet) {
  const module = await import('data:text/javascript;base64,' + Buffer.from(packet.code).toString('base64'));
  if (packet.mode === 'schema') return module.describeDatabase();
  if (packet.mode === 'describe') {
    const tools = Object.entries(module.tools).map(([name, tool]) => {
      if (typeof tool?.execute !== 'function') throw new Error('Tool ' + name + ' needs an execute function.');
      return { name, description: tool.description, inputSchema: tool.inputSchema };
    });
    for (const [name, source] of Object.entries(module.sources)) if (typeof source !== 'function') throw new Error('Source ' + name + ' must export a function.');
    return { tools, collectors: Object.keys(module.sources) };
  }
  if (packet.mode === 'source') return module.sources[packet.name](context);
  return module.tools[packet.name].execute(packet.input, context);
}
lines.on('line', line => {
  const packet = JSON.parse(line);
  if (!start) {
    start = true;
    run(packet).then(value => send({ type: 'result', value: value ?? null }), error => send({ type: 'result', error: String(error.message).slice(0, 2000) })).finally(() => { lines.close(); process.stdin.destroy(); });
  } else {
    const waiter = pending.get(packet.id);
    if (!waiter) return;
    pending.delete(packet.id);
    if (packet.error) waiter.reject(new Error(packet.error)); else waiter.resolve(packet.value);
  }
});
`
