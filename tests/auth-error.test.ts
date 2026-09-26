import { describe, expect, test } from "bun:test"

import { authErrorMessage } from "@/lib/auth-error"

describe("authentication error messages", () => {
  test("does not blame credentials for a Better Fetch HTTP 500 without a message", () => {
    const message = authErrorMessage({ status: 500 }, "sign-up")

    expect(message).toBe(
      "We’re having trouble creating accounts right now. Please try again shortly."
    )
    expect(message).not.toContain("email or password")
  })

  test("does not leak Better Auth schema details", () => {
    const message = authErrorMessage(
      {
        code: "SCHEMA_MISMATCH",
        message: "Missing table: account. Run the schema migration.",
        status: 500,
      },
      "sign-up"
    )

    expect(message).toBe(
      "We’re having trouble creating accounts right now. Please try again shortly."
    )
    expect(message).not.toContain("schema")
    expect(message).not.toContain("Missing table")
    expect(message).not.toContain("migration")
  })

  test("keeps the supplied Better Auth validation message for a 4xx result", () => {
    expect(
      authErrorMessage(
        { message: "Password must be at least 8 characters.", status: 422 },
        "sign-up"
      )
    ).toBe("Password must be at least 8 characters.")
  })

  test("uses the retry message after a network failure", () => {
    expect(authErrorMessage(new TypeError("fetch failed"), "sign-in")).toBe(
      "We’re having trouble signing you in right now. Please try again shortly."
    )
  })
})

test("OAuth linking errors do not incorrectly report a domain rejection", async () => {
  const { oauthErrorMessage } = await import("../lib/auth-error")
  expect(oauthErrorMessage("account_not_linked")).toContain(
    "Google is not linked"
  )
  expect(oauthErrorMessage("account_not_linked")).not.toContain(
    "approved domain"
  )
  expect(oauthErrorMessage("invalid_code")).not.toContain("approved domain")
})
