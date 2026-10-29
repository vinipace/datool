// Guarded patch against Evolution 2.3.7's bundled event dispatcher.
// Wait for updated credentials to persist before handling a reconnect, and
// preserve existing non-blocking behavior for connection handling.
const fs = require('node:fs')
const file = '/evolution/dist/main.js'
const source = fs.readFileSync(file, 'utf8')
const before = 'e["connection.update"]&&this.connectionUpdate(e["connection.update"]),e["creds.update"]&&this.instance.authState.saveCreds(),'
const after = 'e["creds.update"]&&await this.instance.authState.saveCreds(),e["connection.update"]&&this.connectionUpdate(e["connection.update"]),'
if (source.split(before).length !== 2 || source.includes(after)) {
  throw new Error('Unexpected Evolution event dispatcher; refusing unverified patch')
}
fs.writeFileSync(file, source.replace(before, after))
