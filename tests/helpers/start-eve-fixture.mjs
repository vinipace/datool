// Load the actual runtime first: a bundled SDK installs its own Fetch globals.
// Network interception must follow that initialization to remain effective.
await import("../../scripts/start-eve.mjs")
await import("./eve-upstream-preload.mjs")
process.send?.({ testNetworkReady: true })
