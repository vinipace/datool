import { afterEach, beforeEach } from "bun:test"

export function configureBuildTestEnvironment(enabled = "true") {
  let previous: [string | undefined, string | undefined]
  beforeEach(() => {
    previous = [
      process.env.DATOOL_BUILD_ENABLED,
      process.env.DATOOL_BUILD_ORGANIZATION_IDS,
    ]
    process.env.DATOOL_BUILD_ENABLED = enabled
    delete process.env.DATOOL_BUILD_ORGANIZATION_IDS
  })
  afterEach(() => {
    for (const [name, value] of [
      ["DATOOL_BUILD_ENABLED", previous[0]],
      ["DATOOL_BUILD_ORGANIZATION_IDS", previous[1]],
    ]) {
      if (value === undefined) delete process.env[name!]
      else process.env[name!] = value
    }
  })
}
