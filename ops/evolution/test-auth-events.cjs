// Verify ordering in the actual bundled Evolution dispatcher, using delayed
// credential persistence to exercise the race without a real WhatsApp session.
const fs = require('node:fs')
const source = fs.readFileSync('/evolution/dist/main.js', 'utf8')
const before = 'e["connection.update"]&&this.connectionUpdate(e["connection.update"]),e["creds.update"]&&this.instance.authState.saveCreds(),'
const after = 'e["creds.update"]&&await this.instance.authState.saveCreds(),e["connection.update"]&&this.connectionUpdate(e["connection.update"]),'
const found = [before, after].filter((expression) => source.split(expression).length === 2)
if (found.length !== 1) throw new Error('Unrecognized Evolution event dispatcher')
const events = []
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const handler = {
  connectionUpdate: async () => { events.push('reconnect start'); await wait(2); events.push('reconnect finish') },
  instance: { authState: { saveCreds: async () => { events.push('save start'); await wait(20); events.push('save finish') } } },
}
const processEvents = new Function('e', `return (async()=>{return (${found[0]}true)})()`)
;(async () => {
  await processEvents.call(handler, { 'connection.update': { connection: 'close' }, 'creds.update': {} })
  await wait(25)
  if (events.indexOf('save finish') > events.indexOf('reconnect start')) {
    throw new Error('Reconnect started before credential persistence finished')
  }
  process.stdout.write('PASS credential persistence finishes before reconnect starts\n')
})().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
