import { test, expect } from "bun:test"
import { localEndpoint, boundedInteger } from "../scripts/read-load/safety"
test("read load targets reject remote hosts, implicit endpoints and unbounded settings", () => {
  expect(() =>
    localEndpoint("https://example.com", ["http:", "https:"])
  ).toThrow("loopback")
  expect(() =>
    localEndpoint("postgresql://user@db.internal/test", ["postgresql:"])
  ).toThrow("loopback")
  expect(() => localEndpoint("file:///tmp/database", ["postgresql:"])).toThrow(
    "loopback"
  )
  expect(
    localEndpoint("postgresql://test@127.0.0.1:55479/test", ["postgresql:"])
      .hostname
  ).toBe("127.0.0.1")
  expect(() => boundedInteger("Infinity", 10, 1, 1000)).toThrow("integer")
  expect(() => boundedInteger("1001", 10, 1, 1000)).toThrow("integer")
})
