import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

function runAuthSnippet(env: Record<string, string | undefined>, source: string) {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  delete childEnvironment.BETTER_AUTH_SECRET;
  delete childEnvironment.BETTER_AUTH_URL;
  delete childEnvironment.DATABASE_URL;
  Object.assign(childEnvironment, env);

  const child = spawnSync(process.execPath, ["--no-env-file", "--eval", source], {
    cwd: process.cwd(),
    env: childEnvironment,
    encoding: "utf8",
  });

  return {
    exitCode: child.status,
    stderr: String(child.stderr ?? ""),
    stdout: String(child.stdout ?? ""),
  };
}

describe("auth configuration", () => {
  test("config loaders can copy the lazy auth options", () => {
    const result = runAuthSnippet(
      {
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
        BETTER_AUTH_URL: "http://localhost:3000",
        DATABASE_URL: "postgresql://datool:datool@127.0.0.1:1/datool",
      },
      'import("./lib/auth.ts").then(({ auth }) => { if (!Object.assign({}, auth).options) throw new Error("Missing auth options"); process.exit(0) })',
    );

    expect(result.exitCode).toBe(0);
  });

  test("the auth module imports without runtime configuration", () => {
    const result = runAuthSnippet({}, 'import("./lib/auth.ts")');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("auth use reports a missing database URL before opening a connection", () => {
    const result = runAuthSnippet(
      {},
      'import("./lib/auth.ts").then(({ getAuth }) => getAuth())',
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL is required");
  });

  test("production rejects an insecure Better Auth origin", () => {
    const result = runAuthSnippet(
      {
        BETTER_AUTH_SECRET: "01234567890123456789012345678901",
        BETTER_AUTH_URL: "http://localhost:3000",
        DATABASE_URL: "postgresql://datool:datool@127.0.0.1:5432/datool",
        NODE_ENV: "production",
      },
      'import("./lib/auth.ts").then(({ getAuth }) => getAuth())',
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("BETTER_AUTH_URL must use https in production");
  });
});
