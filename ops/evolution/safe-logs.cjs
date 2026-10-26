// Evolution 2.3.7 writes raw message objects directly through console.log.
// Keep provider output metadata-only; operational health is monitored separately.
// This preload never formats arguments, which may contain messages or secrets.
const write = process.stderr.write.bind(process.stderr)
let last = 0
for (const method of ['log', 'info', 'debug', 'trace', 'warn', 'error', 'dir', 'table']) {
  console[method] = () => {
    if ((method === 'warn' || method === 'error') && Date.now() - last > 10000) {
      last = Date.now()
      write(JSON.stringify({ service: 'evolution', level: method, event: 'provider_diagnostic_redacted' }) + '\n')
    }
  }
}
