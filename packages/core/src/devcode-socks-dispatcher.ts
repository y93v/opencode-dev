export * as DevcodeSocksDispatcher from "./devcode-socks-dispatcher.js"

import { openSocks5 } from "./devcode-tor.js"
import * as tlsMod from "node:tls"
import type * as net from "node:net"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname as pathDirname, join as pathJoin } from "node:path"

// DIAG writer — write to a dedicated file, since console.log in the sidecar
// goes to a captured stdout that opencode's structured logger ignores. Any
// diagnostic that needs to be visible to the operator goes through diag().
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

// Routes undici requests through the bundled Tor SOCKS5 proxy when the
// destination host matches a configured allowlist (just opencode.ai for now)
// and leaves everything else on the direct pool.
//
// Why a per-request dispatcher and not a global SOCKS: BYOK calls to the
// user's own anthropic / openai keys should NOT ride Tor — Tor exits get
// Cloudflare-challenged by those providers, add hundreds of ms of latency,
// and defeat keep-alive. We ONLY want opencode.ai traffic (the quota-metered
// path) on Tor; local tools and BYOK keep their fast direct route.

type UndiciModule = typeof import("undici")

let installed = false

function shouldRouteThroughTor(hostname: string): boolean {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === "opencode.ai" || h.endsWith(".opencode.ai")
}

// Build an undici Agent whose connections are SOCKS5-tunneled through the
// local Tor. The custom `connect` opens a raw CONNECT to <host>:<port> via
// 127.0.0.1:9150, then wraps TLS when the request is https (which it always
// is for opencode.ai). undici handles the HTTP layering on top.
function buildTorAgent(undici: UndiciModule): import("undici").Agent {
  const Agent = undici.Agent
  // undici's `connect` option type varies by minor version; cast to the
  // loose Function shape so TS doesn't complain about parameter counts.
  const connect = (async (
    opts: { hostname?: string; host?: string; port?: number | string; protocol?: string; servername?: string },
    cb: (err: Error | null, sock: net.Socket | null) => void,
  ) => {
    try {
      const host = opts.hostname ?? opts.host ?? ""
      const port = Number(opts.port ?? 443)
      const protocol = opts.protocol ?? "https:"
      const servername = opts.servername ?? host
      const rawSock = await openSocks5(host, port, 20_000)
      if (protocol === "https:") {
        const tls = tlsMod.connect({
          socket: rawSock,
          servername,
          ALPNProtocols: ["http/1.1"],
        })
        const onSecure = () => {
          tls.removeListener("error", onErr)
          cb(null, tls as unknown as net.Socket)
        }
        const onErr = (e: Error) => {
          tls.removeListener("secureConnect", onSecure)
          cb(e, null)
        }
        tls.once("secureConnect", onSecure)
        tls.once("error", onErr)
      } else {
        cb(null, rawSock)
      }
    } catch (e) {
      cb(e as Error, null)
    }
  }) as unknown as import("undici").buildConnector.connector

  return new Agent({
    connect,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 20_000,
    pipelining: 0,
  })
}

// Install once per sidecar process. Replaces the global dispatcher with a
// router that picks Tor vs direct per request. Safe to call from any
// plugin's init hook; idempotent.
export async function installTorRoutingDispatcher(): Promise<{ installed: boolean; reason?: string }> {
  if (installed) return { installed: true }
  let undici: UndiciModule
  try {
    undici = (await import("undici")) as UndiciModule
  } catch (e) {
    return { installed: false, reason: `undici not available: ${(e as Error).message}` }
  }
  if (!undici.Agent || !undici.setGlobalDispatcher) {
    return { installed: false, reason: "undici Agent/setGlobalDispatcher missing" }
  }

  const directAgent = new undici.Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 20_000,
  })
  const torAgent = buildTorAgent(undici)

  // Router: a Dispatcher that forwards per-request to either the Tor agent
  // or the direct agent, keyed on the request's host. undici's Dispatcher is
  // an abstract class — we subclass and override dispatch/close/destroy.
  const DispatcherBase = undici.Dispatcher as unknown as { new (): import("undici").Dispatcher }
  type DispatchOptions = Parameters<import("undici").Dispatcher["dispatch"]>[0]
  type DispatchHandler = Parameters<import("undici").Dispatcher["dispatch"]>[1]
  // DIAG: counter so we can tell separate calls apart in the log stream.
  let dispatchSeq = 0
  class RouterDispatcher extends DispatcherBase {
    override dispatch(opts: DispatchOptions, handler: DispatchHandler): boolean {
      try {
        const origin = (opts.origin ?? "") as string
        let hostname = ""
        if (origin) {
          try {
            hostname = new URL(origin.toString()).hostname
          } catch {
            hostname = ""
          }
        }
        const isOC = shouldRouteThroughTor(hostname)
        const target = isOC ? torAgent : directAgent
        if (hostname) {
          const seq = ++dispatchSeq
          const method = (opts as { method?: string }).method ?? "?"
          const path = (opts as { path?: string }).path ?? "/"
          // Only log the first 80 chars of path so query params with secrets don't flood.
          const shortPath = path.length > 80 ? path.slice(0, 80) + "…" : path
          diag(`[dispatcher] #${seq} ${method} ${hostname}${shortPath} -> ${isOC ? "TOR" : "DIRECT"}`)
          // Wrap the handler to log response status + response headers + body excerpt.
          // Only wrap opencode.ai paths — too noisy otherwise.
          if (isOC) {
            const start = handler.onResponseStart?.bind(handler)
            const data = handler.onResponseData?.bind(handler)
            const end = handler.onResponseEnd?.bind(handler)
            let status = 0
            const respHeaders: Record<string, string | string[]> = {}
            let bodyBuf = ""
            handler.onResponseStart = (controller, statusCode, headers, statusMessage) => {
              status = statusCode
              // undici 7 passes IncomingHttpHeaders; older builds passed a
              // Buffer[] of alternating name/value pairs. Accept both.
              try {
                if (Array.isArray(headers)) {
                  const list = headers as unknown as Array<Buffer | string>
                  for (let i = 0; i < list.length; i += 2) {
                    const name = (list[i] as Buffer).toString("utf8").toLowerCase()
                    const val = (list[i + 1] as Buffer).toString("utf8")
                    respHeaders[name] = val
                  }
                } else if (headers && typeof headers === "object") {
                  for (const [name, value] of Object.entries(headers)) {
                    if (value !== undefined) respHeaders[name.toLowerCase()] = value as string | string[]
                  }
                }
              } catch { /* ignore */ }
              start?.(controller, statusCode, headers, statusMessage)
            }
            handler.onResponseData = (controller, chunk) => {
              try {
                if (bodyBuf.length < 2048) bodyBuf += chunk.toString("utf8")
              } catch { /* ignore */ }
              data?.(controller, chunk)
            }
            handler.onResponseEnd = (controller, trailers) => {
              try {
                const rl = JSON.stringify({
                  "cf-ray": respHeaders["cf-ray"],
                  "x-request-id": respHeaders["x-request-id"],
                  "x-ratelimit-remaining": respHeaders["x-ratelimit-remaining"],
                  "x-ratelimit-limit": respHeaders["x-ratelimit-limit"],
                  "x-ratelimit-reset": respHeaders["x-ratelimit-reset"],
                  "ratelimit-remaining": respHeaders["ratelimit-remaining"],
                  "ratelimit-limit": respHeaders["ratelimit-limit"],
                  "retry-after": respHeaders["retry-after"],
                  "content-type": respHeaders["content-type"],
                  "cf-cache-status": respHeaders["cf-cache-status"],
                  "server": respHeaders["server"],
                })
                diag(`[dispatcher] #${seq} response status=${status} ${rl}`)
                const excerpt = bodyBuf.length > 800 ? bodyBuf.slice(0, 800) + "…" : bodyBuf
                diag(`[dispatcher] #${seq} body: ${excerpt.replace(/\n/g, " ")}`)
              } catch { /* ignore */ }
              end?.(controller, trailers)
            }
          }
        }
        return target.dispatch(opts, handler)
      } catch (e) {
        diag(`[dispatcher] ERROR routing: ${(e as Error).message}`)
        return directAgent.dispatch(opts, handler)
      }
    }
    override async close(): Promise<void> {
      await Promise.all([torAgent.close(), directAgent.close()])
    }
    // undici declares destroy with both callback and promise overloads. One
    // signature accepting either argument shape satisfies all of them.
    override async destroy(arg?: Error | null | (() => void)): Promise<void> {
      if (typeof arg === "function") {
        arg()
        return
      }
      await Promise.all([torAgent.destroy(arg ?? null), directAgent.destroy(arg ?? null)])
    }
  }

  undici.setGlobalDispatcher(new RouterDispatcher())
  installed = true
  return { installed: true }
}

// Exposed for the opencode provider: a `fetch`-compatible function that
// routes every request through the bundled Tor SOCKS5. The AI SDK uses
// `FetchHttpClient.Fetch` (effect/http) for outbound inference requests,
// which bypasses undici.setGlobalDispatcher — so the only reliable way to
// get opencode.ai traffic through Tor is to inject this fetch into the
// opencode provider's `settings.fetch`, which the SDK then calls per
// request.
let _torFetchAgent: import("undici").Agent | null = null
export async function torFetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> {
  const undici = (await import("undici")) as typeof import("undici")
  if (!_torFetchAgent) {
    _torFetchAgent = (
      undici.Agent
        ? new undici.Agent({
            connect: async (
              opts: { hostname?: string; host?: string; port?: number | string; protocol?: string; servername?: string },
              cb: (err: Error | null, sock: import("node:net").Socket | null) => void,
            ) => {
              try {
                const host = opts.hostname ?? opts.host ?? ""
                const port = Number(opts.port ?? 443)
                const protocol = opts.protocol ?? "https:"
                const servername = opts.servername ?? host
                const rawSock = await openSocks5(host, port, 20_000)
                if (protocol === "https:") {
                  const tls = tlsMod.connect({
                    socket: rawSock,
                    servername,
                    ALPNProtocols: ["http/1.1"],
                  })
                  const onSecure = () => {
                    tls.removeListener("error", onErr)
                    cb(null, tls as unknown as import("node:net").Socket)
                  }
                  const onErr = (e: Error) => {
                    tls.removeListener("secureConnect", onSecure)
                    cb(e, null)
                  }
                  tls.once("secureConnect", onSecure)
                  tls.once("error", onErr)
                } else {
                  cb(null, rawSock)
                }
              } catch (e) {
                cb(e as Error, null)
              }
            },
            keepAliveTimeout: 10_000,
            keepAliveMaxTimeout: 20_000,
            pipelining: 0,
          } as never)
        : null
    ) as import("undici").Agent
  }
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    diag(`[torFetch] -> ${url}`)
  } catch { /* ignore */ }
  // undici.fetch accepts a dispatcher option that overrides the global.
  // Pass our tor agent so this exact call goes through SOCKS5 regardless
  // of what the global dispatcher is set to.
  const res = (await (undici as unknown as {
    fetch: (
      u: Parameters<typeof globalThis.fetch>[0],
      init?: Omit<RequestInit, "dispatcher"> & { dispatcher?: unknown },
    ) => Promise<Response>
  }).fetch(input, { ...init, dispatcher: _torFetchAgent })) as Response
  try {
    diag(`[torFetch] <- status=${res.status} url=${res.url}`)
  } catch { /* ignore */ }
  return res
}

// Reset the tor agent so the next torFetch call opens a fresh tunnel
// (useful after SIGNAL NEWNYM).
export function resetTorFetchAgent(): void {
  try { _torFetchAgent?.destroy() } catch { /* ignore */ }
  _torFetchAgent = null
}

// Monkey-patch globalThis.fetch so EVERY fetch call in the sidecar goes
// through our router.
//
// Why this is necessary: @opencode/ai's RequestExecutor uses
// FetchHttpClient.Fetch, which by default is bound to globalThis.fetch.
// Node's built-in globalThis.fetch is backed by Node's INTERNAL undici
// (not the "undici" npm package). Calling setGlobalDispatcher on the
// imported undici does not affect Node's built-in fetch, which is why
// our dispatcher plumbing never saw opencode.ai traffic.
//
// Replacing globalThis.fetch itself makes every consumer (effect/http
// FetchHttpClient, the AI SDK, random utility code, the auto-updater)
// go through our routing decision. opencode.ai hosts go through torFetch
// (SOCKS5 to bundled Tor); everything else falls through to the original
// native fetch untouched, so BYOK calls, R2 downloads, model catalog
// fetches, etc. are not slowed down by Tor.
let _globalFetchOverridden = false
let _originalGlobalFetch: typeof globalThis.fetch | null = null
export function installGlobalFetchOverride(): { installed: boolean; reason?: string } {
  if (_globalFetchOverridden) return { installed: true }
  if (typeof globalThis.fetch !== "function") return { installed: false, reason: "globalThis.fetch not a function" }
  _originalGlobalFetch = globalThis.fetch.bind(globalThis)
  const routed: typeof globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url
      const host = new URL(url).hostname.toLowerCase()
      if (shouldRouteThroughTor(host)) {
        diag(`[global-fetch] routing ${host} through torFetch`)
        return (await torFetch(input, init)) as Response
      }
    } catch (e) {
      diag(`[global-fetch] ERROR extracting url: ${(e as Error).message}, using original fetch`)
    }
    return _originalGlobalFetch!(input as Parameters<typeof globalThis.fetch>[0], init)
  }) as typeof globalThis.fetch
  ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = routed
  _globalFetchOverridden = true
  diag(`[global-fetch] globalThis.fetch replaced with router`)
  return { installed: true }
}

// For the reset handler: tear down the global dispatcher so idle keep-alive
// sockets through the OLD tor circuit are dropped, then rebuild it fresh so
// the next request opens a new SOCKS tunnel (which lands on the new circuit
// Tor is routing per NEWNYM).
export async function recycleTorPool(): Promise<void> {
  try {
    const undici = (await import("undici")) as UndiciModule
    const current = undici.getGlobalDispatcher()
    try {
      await (current as unknown as { destroy?: (e?: Error) => Promise<void> }).destroy?.()
    } catch { /* ignore */ }
    installed = false
    await installTorRoutingDispatcher()
  } catch {
    /* non-fatal: next request opens a fresh circuit anyway */
  }
  // Also tear down the standalone tor fetch agent so provider-level fetch
  // calls open a fresh tunnel through the new NEWNYM circuit.
  resetTorFetchAgent()
}
