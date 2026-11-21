export * as DevcodeAutoRotatePlugin from "./devcode-auto-rotate.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { dirname as pathDirname, join as pathJoin } from "node:path"

// DevCode auto-rotate on opencode.ai quota refusal.
//
// On a 429 or 403 from opencode.ai whose body carries a known quota-error
// signature (FreeUsageLimit, BudgetLimit, GoUsageLimit, "usage limit",
// "limit reached"), this plugin:
//
//   1. rotates the WARP registration so the next request leaves on a fresh
//      Cloudflare egress IP (per-IP anonymous bucket resets),
//   2. stamps a fresh fingerprint file so the ua-spoof plugin derives new
//      wire ids for every session / project / client / UA header the next
//      request ships (per-identity bucket resets, from the server's view).
//
// The current request's error still bubbles to the user — the AI SDK's
// retry logic doesn't retry 503s on quota-exceeded, and holding the
// response open past Cloudflare's edge timeout breaks worse than letting
// the one request fail cleanly. By the time the user retries (even a
// second later) WARP is on a new identity with a new counter and the wire
// fingerprint is new, so the retry just works. Matches the standard
// "automatic WARP rotation on 429" pattern used by external proxies like
// opencode-infinite-proxy.
//
// Toggles:
//   DEVCODE_AUTO_ROTATE=1  enable (default OFF — the Reset pill is the
//     only authorised trigger; this plugin exists as an opt-in escape
//     hatch for scripted / non-interactive flows).
//   DEVCODE_AUTO_ROTATE_MAX_PER_HOUR=<n>  cap rotations per rolling
//     hour (default 30). Hitting the cap lets the 429 pass through.

const ENABLED = ((process.env.DEVCODE_AUTO_ROTATE ?? "0").toLowerCase() === "1" ||
                 (process.env.DEVCODE_AUTO_ROTATE ?? "").toLowerCase() === "true")
const MAX_PER_HOUR = Number(process.env.DEVCODE_AUTO_ROTATE_MAX_PER_HOUR ?? "30") || 30

const WARP_CANDIDATES = [
  "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
  "C:\\Program Files (x86)\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
]

function resolveWarpCli(): string | undefined {
  for (const c of WARP_CANDIDATES) if (existsSync(c)) return c
  return undefined
}

function fingerprintPath(): string {
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  return pathJoin(data, "opencode", "devcode-fingerprint.json")
}

// Keep in sync with the reset handler's pool so manual-reset-UA and auto-
// rotate-UA come from the same distribution.
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
] as const

function rotateFingerprintFile(): void {
  try {
    const nonce = randomBytes(32).toString("hex")
    const uaIdx = randomBytes(1)[0] % UA_POOL.length
    const ua = UA_POOL[uaIdx]
    const clientLabel = "oc-" + randomBytes(6).toString("hex")
    const file = fingerprintPath()
    mkdirSync(pathDirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ nonce, ua, clientLabel, stamped: Date.now() }),
      { encoding: "utf8" },
    )
  } catch {
    /* non-fatal; next request keeps using the previous fingerprint */
  }
}

const rotationHistory: number[] = []
let rotationInFlight: Promise<void> | undefined

function allowRotation(): boolean {
  const cutoff = Date.now() - 3600_000
  while (rotationHistory.length && rotationHistory[0] < cutoff) rotationHistory.shift()
  return rotationHistory.length < MAX_PER_HOUR
}

function doRotation(warp: string | undefined): Promise<void> {
  if (rotationInFlight) return rotationInFlight
  rotationInFlight = new Promise<void>((resolve) => {
    rotationHistory.push(Date.now())
    // Fingerprint first (cheap, always safe) then WARP (slower, system-
    // level). Order doesn't matter for correctness but writing the file
    // first means that if WARP hangs we still stamped the new identifier.
    rotateFingerprintFile()
    if (!warp) {
      resolve()
      return
    }
    const run = (args: string[]) =>
      new Promise<void>((done) => {
        const c = spawn(warp, args, { stdio: "ignore", windowsHide: true })
        c.on("exit", () => done())
        c.on("error", () => done())
        setTimeout(done, 4000)
      })
    ;(async () => {
      await run(["--accept-tos", "registration", "delete"])
      await run(["--accept-tos", "registration", "new"])
      await new Promise((r) => setTimeout(r, 1500))
      resolve()
    })()
  }).finally(() => {
    rotationInFlight = undefined
  })
  return rotationInFlight
}

function isOpencodeURL(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === "opencode.ai" || h.endsWith(".opencode.ai")
  } catch {
    return false
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    const clone = response.clone()
    return await clone.text()
  } catch {
    return ""
  }
}

const QUOTA_BODY = /FreeUsageLimit|BudgetLimit|GoUsageLimit|usage limit|limit reached/i

export const Plugin = define({
  id: "devcode.auto-rotate",
  effect: Effect.fn("DevcodeAutoRotatePlugin")(function* (ctx) {
    if (!ENABLED) return
    const warp = resolveWarpCli()
    // Even without WARP installed we still rotate the fingerprint — a fresh
    // wire identity alone resets the per-identity bucket on opencode.ai's
    // side, which recovers one of the two limit classes (session-keyed).
    // The per-IP class still bites until warp-cli is present.

    const hook = (event: SessionHooks["http.response"]) =>
      Effect.gen(function* () {
        if (!isOpencodeURL(event.request.url)) return
        const status = event.response.status
        if (status !== 429 && status !== 403) return

        const body = yield* Effect.promise(() => readBody(event.response))
        if (!QUOTA_BODY.test(body)) return

        if (!allowRotation()) return

        // Fire-and-forget. The current request's quota error still reaches
        // the user; the NEXT request lands on the rotated identity.
        void doRotation(warp)
      }).pipe(Effect.catch(() => Effect.void))

    yield* ctx.session.hook("http.response", hook)
  }),
})
