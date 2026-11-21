export * as DevcodeBootstrap from "./devcode-bootstrap.js"

// Runs at CLI startup, BEFORE any effect/http layer loads. Replaces
// globalThis.fetch with a routing function so every downstream consumer
// (effect/http's FetchHttpClient, the AI SDK, random utility code) that
// captures a reference to globalThis.fetch gets OUR routed version from
// the start.
//
// Critical ordering reason: effect/http's FetchHttpClient layer binds
// to globalThis.fetch at layer-eval time. If we patch globalThis.fetch
// AFTER the layer is already constructed, the layer still has the old
// reference and our patch is invisible to inference traffic.
//
// Why not do this in the ua-spoof plugin: plugins load after effect
// layers are already set up. This file imports first, before anything.

import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname as pathDirname, join as pathJoin } from "node:path"

const DIAG_PATH = (() => {
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  return pathJoin(data, "opencode", "log", "devcode-diag.log")
})()
let diagDirOk = false
function diag(line: string): void {
  try {
    if (!diagDirOk) {
      mkdirSync(pathDirname(DIAG_PATH), { recursive: true })
      diagDirOk = true
    }
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch { /* ignore */ }
}

function shouldRouteThroughTor(hostname: string): boolean {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === "opencode.ai" || h.endsWith(".opencode.ai")
}

// Must run at module load. Side-effectful by design.
;(function patchGlobalFetchEarly() {
  try {
    if (typeof globalThis.fetch !== "function") return
    if ((globalThis as { __devcodeFetchPatched?: boolean }).__devcodeFetchPatched) return
    const original = globalThis.fetch.bind(globalThis)
    ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url
        const host = new URL(url).hostname.toLowerCase()
        if (shouldRouteThroughTor(host)) {
          diag(`[bootstrap-fetch] routing ${host} through torFetch`)
          // Lazy-import torFetch so this file has no heavy deps at load time.
          const mod = await import("./devcode-socks-dispatcher.js")
          return (await mod.DevcodeSocksDispatcher.torFetch(input, init)) as Response
        }
      } catch (e) {
        diag(`[bootstrap-fetch] ERROR: ${(e as Error).message}, falling through`)
      }
      return original(input as Parameters<typeof globalThis.fetch>[0], init)
    }) as typeof globalThis.fetch
    ;(globalThis as { __devcodeFetchPatched?: boolean }).__devcodeFetchPatched = true
    diag(`[bootstrap-fetch] EARLY patch installed (before any effect/http layer)`)
  } catch (e) {
    diag(`[bootstrap-fetch] FAILED to install: ${(e as Error).message}`)
  }
})()
