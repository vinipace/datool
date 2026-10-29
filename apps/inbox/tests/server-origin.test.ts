import { expect, test } from "bun:test"

test("hosted auth uses the canonical origin while retaining build 11 offline storage keys", async () => {
  for (const [configured, api, storage] of [
    ["https://trydatool.com", "https://www.trydatool.com", "https://trydatool.com"],
    ["https://www.trydatool.com/", "https://www.trydatool.com", "https://trydatool.com"],
    ["https://support.example.test/", "https://support.example.test", "https://support.example.test"],
  ]) {
    // Isolate build-time env evaluation; don't mutate the test process's module cache.
    const result = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      globalThis.__DEV__ = false;
      const config = await import(${JSON.stringify(new URL("../src/lib/server-url.ts", import.meta.url).pathname)});
      config.assertApiUrl();
      console.log(JSON.stringify([config.API_URL, config.STORAGE_SCOPE]));
    `], { env: { ...process.env, EXPO_PUBLIC_API_URL: configured }, stdout: "pipe", stderr: "pipe" })
    expect(await result.exited).toBe(0)
    expect(JSON.parse(await new Response(result.stdout).text())).toEqual([api, storage])
  }
})
