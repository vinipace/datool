import { spawn, type ChildProcess } from "node:child_process"
import { dirname, resolve } from "node:path"
import { projectRoot } from "./config"
import type { BridgeSession } from "./app-bridge"
import { appRequest } from "./request"
import { watchSourceFiles } from "./connect-source-watch"

/** This process never imports user code. Each candidate gets a clean module cache. */
export async function watchConnection(
  target: string,
  args: string[],
  root: string,
  origin: string
) {
  const workers = new Set<ChildProcess>()
  const preparedWorkers = new Set<ChildProcess>()
  let active: ReturnType<typeof start> | undefined
  let session: BridgeSession | undefined
  let stopped = false
  let version = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let reload: Promise<void> | undefined
  let fatal: Error | undefined
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })

  function start() {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1], "connect", ...args, "--no-watch"],
      {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: { ...process.env, DATOOL_CONNECT_WORKER: "1" },
      }
    )
    workers.add(child)
    let ready!: (value: boolean) => void
    const prepared = new Promise<boolean>((resolve) => {
      ready = resolve
    })
    let listening = false
    child.on("message", (message) => {
      if (message === "prepared") {
        preparedWorkers.add(child)
        ready(true)
      }
      if (message && typeof message === "object" && "session" in message) {
        session = message.session as BridgeSession
        listening = true
      }
    })
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        console.error(error.message)
        workers.delete(child)
        ready(false)
        resolve(null)
      })
      child.once("exit", (code) => {
        workers.delete(child)
        preparedWorkers.delete(child)
        ready(false)
        resolve(code)
        if (active?.child === child && !stopped) {
          if (!listening) {
            active = undefined
            console.error(
              "Reload activation failed before accepting calls; fix the files or connection and save a file to retry."
            )
            return
          }
          // Never restart/replay after an unexpected worker failure. Its delivery
          // state is uncertain, so the operator must inspect the saved calls.
          fatal = new Error(
            "Watched listener exited unexpectedly. Inspect saved calls before reconnecting; no calls were replayed."
          )
          stop()
        }
      })
    })
    return { child, prepared, exited }
  }

  async function replace() {
    const candidateVersion = version
    const candidate = start()
    if (!(await candidate.prepared)) {
      console.error(
        "Reload failed; fix the local files to retry. The previous listener is unchanged."
      )
      return
    }
    if (stopped || candidateVersion !== version) {
      candidate.child.send("stop")
      await candidate.exited
      return
    }
    const previous = active
    active = undefined
    if (previous) {
      console.info(
        "Reloading: finishing active calls and delivering their results…"
      )
      previous.child.send("drain")
      const code = await previous.exited
      if (code !== 0) {
        candidate.child.send("stop")
        fatal = new Error(
          "Listener could not drain safely. Inspect saved calls before reconnecting; no calls were replayed."
        )
        stop()
        return
      }
    }
    if (stopped) {
      candidate.child.send("stop")
      await candidate.exited
      return
    }
    // Even if another edit arrived during draining, activate this validated
    // candidate first to keep the mailbox live. The next reload takes the latest edit.
    active = candidate
    candidate.child.send({ activate: true, resume: session })
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (stopped) return
      if (reload) {
        schedule()
        return
      }
      const before = version
      reload = replace()
        .catch((error: Error) => {
          fatal = error
          stop()
        })
        .finally(() => {
          reload = undefined
          if (!stopped && before !== version) schedule()
        })
    }, 250)
  }

  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    for (const child of workers) {
      // Prepared candidates exit; an activated listener drains on either command.
      if (!preparedWorkers.has(child)) child.kill("SIGTERM")
      else if (child.connected) child.send("stop")
    }
    finish()
  }
  const roots = [
    ...new Set([resolve(root), projectRoot(dirname(target))]),
  ].filter(
    (directory, index, all) =>
      !all.some(
        (parent, other) => index !== other && directory.startsWith(`${parent}/`)
      )
  )
  let closeWatcher: (() => void) | undefined
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    closeWatcher = await watchSourceFiles(
      roots,
      () => {
        version++
        schedule()
      },
      (error) => {
        fatal = error
        stop()
      }
    )
    console.info(
      `Watching local source and config files in ${roots.join(", ")} (250 ms debounce). Ctrl+C drains active calls.`
    )
    schedule()
    await finished
    await reload
    await Promise.all(
      [...workers].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve()
            else child.once("exit", () => resolve())
          })
      )
    )
    // Shutdown during a reload may leave a drained mailbox without a worker.
    // A failed drain/worker may still have unacknowledged results. Preserve its
    // mailbox for recovery instead of overwriting uncertain calls on disconnect.
    if (session && !fatal) {
      try {
        await appRequest(origin, "/api/apps/bridges", {
          ...session,
          disconnect: true,
        })
      } catch {
        /* Lease expiry is the fallback. */
      }
    }
    if (fatal) throw fatal
  } finally {
    closeWatcher?.()
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

/** Wait for the supervisor only after import/manifest validation, before syncing. */
export async function prepareConnectionWorker() {
  const controller = new AbortController()
  let activate!: (value: { activated: boolean; resume?: BridgeSession }) => void
  const activated = new Promise<{ activated: boolean; resume?: BridgeSession }>(
    (resolve) => {
      activate = resolve
    }
  )
  process.on("message", (message) => {
    if (message && typeof message === "object" && "activate" in message)
      activate({
        activated: true,
        resume: (message as { resume?: BridgeSession }).resume,
      })
    if (message === "drain" || message === "stop") {
      controller.abort(message === "drain" ? "reload" : "stop")
      activate({ activated: false })
    }
  })
  process.once("disconnect", () => {
    controller.abort()
    activate({ activated: false })
  })
  process.send!("prepared")
  return { ...(await activated), signal: controller.signal }
}
