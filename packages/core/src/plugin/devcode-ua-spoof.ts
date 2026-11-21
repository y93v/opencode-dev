export * as DevcodeUASpoofPlugin from "./devcode-ua-spoof.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname as pathDirname, join as joinPath } from "node:path"
import { installGlobalFetchOverride, installTorRoutingDispatcher } from "../devcode-socks-dispatcher.js"
import { ensureTor } from "../devcode-tor.js"

// DIAG file writer — stdout from the sidecar is captured by Electron and
// doesn't reach opencode.log. Write to a dedicated file so the operator can
// actually read what's happening on each opencode.ai request.
const DIAG_PATH = (() => {
  const data = process.env.XDG_DATA_HOME || joinPath(homedir(), ".local", "share")
  return joinPath(data, "opencode", "log", "devcode-diag.log")
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

// DevCode outbound-identity rewriter for opencode.ai.
//
// Every outbound request heading at opencode.ai gets its session / project /
// client / UA headers rewritten to values the server has never seen before,
// bound to the current reset epoch. Local DB rows keep their real ids — chat
// history, tabs, cost tracking, forks all keep working exactly as upstream
// expects. Only what crosses the wire changes.
//
// Rotation lifecycle:
//   - The Reset pill stamps <XDG_DATA>/opencode/devcode-fingerprint.json
//     with { nonce, ua, clientLabel, stamped }.
//   - This plugin reads the file at cold start and caches the values in-
//     process for the life of the sidecar. The reset path exits the sidecar
//     right after it writes the file, so the next process reads the fresh
//     values on respawn — no mid-process reload needed.
//   - Wire ids are derived deterministically from (nonce, real-id) so
//     intra-session consistency is preserved: opencode.ai's routing /
//     stream management sees one stable id per message chain, just not the
//     id the local DB holds.
//   - BYOK calls (any non-opencode.ai host) pass through untouched so vendor
//     servers see a stable client identity.
//
// Fallback: if the fingerprint file is missing or unreadable (first run,
// corrupted state, DB on a different user's XDG), the plugin falls back to
// the previous behaviour — honours DEVCODE_SPOOF_SESSION / DEVCODE_SPOOF_UA
// env vars, otherwise no-op.

type Fingerprint = {
  nonce: string
  ua: string
  clientLabel: string
}

function resolveFingerprintPath(): string {
  const data = process.env.XDG_DATA_HOME || joinPath(homedir(), ".local", "share")
  return joinPath(data, "opencode", "devcode-fingerprint.json")
}

// Cached on first use so each request doesn't stat the disk. Re-read if the
// file's mtime changes (lets a reset that happens inside the same sidecar
// lifetime take effect without a restart, defence in depth even though the
// reset path exits the sidecar anyway).
let cachedFingerprint: Fingerprint | null = null
let cachedMtime = 0

function loadFingerprint(): Fingerprint | null {
  try {
    const file = resolveFingerprintPath()
    const stat = statSync(file)
    const mtime = stat.mtimeMs
    if (cachedFingerprint && mtime === cachedMtime) return cachedFingerprint
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as Partial<Fingerprint>
    if (typeof parsed.nonce !== "string" || parsed.nonce.length < 16) return null
    if (typeof parsed.ua !== "string" || !parsed.ua) return null
    if (typeof parsed.clientLabel !== "string" || !parsed.clientLabel) return null
    cachedFingerprint = {
      nonce: parsed.nonce,
      ua: parsed.ua,
      clientLabel: parsed.clientLabel,
    }
    cachedMtime = mtime
    return cachedFingerprint
  } catch {
    return null
  }
}

// Derive a stable-per-reset-epoch wire id from the real id + the nonce. Shape
// matches opencode's own `ses_<64 hex>` so the id reads as a native one on
// the server side.
function deriveWireId(realID: string, nonce: string, prefix: string): string {
  const h = createHash("sha256")
  h.update(nonce)
  h.update("\u0000")
  h.update(realID)
  return `${prefix}_` + h.digest("hex")
}

// A pool of plausible modern UAs for the env-var fallback path. The reset
// handler keeps its own identical pool and stamps whichever one it picks into
// the fingerprint file; this list is only consulted when no file exists.
const FALLBACK_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
] as const

function pickFallbackUA(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return FALLBACK_UAS[Math.abs(h) % FALLBACK_UAS.length]
}

function isOpencodeHost(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    return host === "opencode.ai" || host.endsWith(".opencode.ai")
  } catch {
    return false
  }
}

const envBool = (name: string, fallback: boolean) => {
  const v = (process.env[name] ?? "").toLowerCase()
  if (["1", "true", "yes", "on"].includes(v)) return true
  if (["0", "false", "no", "off"].includes(v)) return false
  return fallback
}

// Defaults flipped to true. The previous "fail-open" behaviour meant that if
// the reset handler's rotateFingerprint() silently failed (returned null on
// a swallowed catch) or never ran (pill click rejected at the directive
// gate), opencode.ai saw the native session + UA on every request and
// bucketed it accordingly. With fallback spoofing ON, even a fingerprint-
// file-less sidecar still rotates per-request; the identity carried across
// the wire is always fresh, even if the stable per-reset identity path
// didn't fire. Env overrides survive for live-debugging:
//   DEVCODE_SPOOF_SESSION=0  disables session-id fallback
//   DEVCODE_SPOOF_UA=0       keeps native UA in fallback
const FALLBACK_SPOOF_SESSION = envBool("DEVCODE_SPOOF_SESSION", true)
const FALLBACK_SPOOF_UA = envBool("DEVCODE_SPOOF_UA", true)
const FALLBACK_SPOOF_CLIENT = envBool("DEVCODE_SPOOF_CLIENT", true)

function freshSessionID(): string {
  return "ses_" + randomBytes(32).toString("hex")
}

// Fire the "plugin loaded" log exactly once per sidecar startup so each run
// confirms registration in the log without spamming every request.
let loggedLoad = false

// Fire the "fingerprint applied" log exactly once per sidecar startup so we
// can confirm the file is being READ and APPLIED without spamming every
// request. If the fingerprint is rotated mid-process, the mtime-based
// cache invalidation inside loadFingerprint() flips `loggedApply` back off
// so the next request re-logs the new nonce.
let loggedApply = false
let loggedApplyFingerprint = ""

export const Plugin = define({
  id: "devcode.spoof.user-agent",
  effect: Effect.fn("DevcodeUASpoofPlugin")(function* (ctx) {
    if (!loggedLoad) {
      loggedLoad = true
      yield* Effect.logInfo("devcode-ua-spoof: plugin registered")
    }

    // Install the global undici dispatcher that routes opencode.ai outbound
    // traffic through the bundled Tor SOCKS5 proxy, and BYOK traffic
    // (anthropic/openai keys) through the direct pool unchanged. Idempotent
    // — safe to run every plugin init. Tor itself bootstraps lazily on the
    // first reset click; until then opencode.ai dispatches get queued waiting
    // for the SOCKS5 port to come up, which is fine on the first launch
    // because no reset has happened yet so the user isn't hitting quota.
    //
    // We kick off ensureTor() in the background so that the first reset
    // click doesn't pay the full 20s cold-start cost — by the time the user
    // hits the pill, tor is already bootstrapped.
    // v20 — Tor dispatcher + global fetch override DISABLED by default.
    //
    // Both were actively harmful: they forcibly routed opencode.ai through
    // our SOCKS5 Tor tunnel, which Cloudflare lumps into one bot-bucketed
    // "Tor" quota pool, so every request landed in a bucket drained by
    // every abuser on the planet. opencode-infinite (which works) proves
    // the right path is to let HTTPS_PROXY=127.0.0.1:40000 (WARP local
    // proxy, set by fresh.ps1 on Electron relaunch) handle egress instead.
    //
    // Opt back in via DEVCODE_FORCE_TOR=1 (same flag the bootstrap
    // module honours). Kept as a debugging escape hatch.
    if (process.env.DEVCODE_FORCE_TOR === "1") {
      const installRes = yield* Effect.promise(() => installTorRoutingDispatcher())
      yield* Effect.logInfo("devcode-ua-spoof: tor dispatcher install (DEVCODE_FORCE_TOR=1)", installRes)
      const fetchOverride = installGlobalFetchOverride()
      yield* Effect.logInfo("devcode-ua-spoof: global fetch override (DEVCODE_FORCE_TOR=1)", fetchOverride)
    } else {
      yield* Effect.logInfo("devcode-ua-spoof: Tor routing disabled; HTTPS_PROXY (from fresh.ps1) handles egress via WARP")
    }
    // Background bootstrap — fire-and-forget, logs its own outcome.
    //
    // Effect.catchCause (not catchAllCause). The Effect version this runtime
    // ships does not export catchAllCause; calling it throws at plugin init
    // and the model.request hook below NEVER REGISTERS. opencode.ai then
    // sees real session IDs + bearer every outbound request, quota bucket
    // stays pinned to the identity, and Tor rotation alone is useless
    // because the bucket is session-keyed. Bug shipped in 2026.11.08.5;
    // fixed here for 2026.11.08.6.
    Effect.runFork(
      Effect.promise(() => ensureTor()).pipe(
        Effect.tap((r) => Effect.logInfo("devcode-ua-spoof: tor bootstrap", r)),
        Effect.catchCause((c) => Effect.logInfo("devcode-ua-spoof: tor bootstrap failed", { cause: String(c) })),
      ),
    )

    const hook = (event: SessionHooks["model.request"]) =>
      Effect.gen(function* () {
        const isOC = isOpencodeHost(event.baseURL)
        if (!isOC) return

        const fp = loadFingerprint()

        if (fp) {
          if (!loggedApply || loggedApplyFingerprint !== fp.nonce) {
            loggedApply = true
            loggedApplyFingerprint = fp.nonce
            yield* Effect.logInfo("devcode-ua-spoof: applying fingerprint", {
              nonce: fp.nonce.slice(0, 12) + "…",
              ua: fp.ua.slice(0, 40) + "…",
              client: fp.clientLabel,
              baseURL: event.baseURL,
            })
          }

          // Full rotation. Both session-ish headers and UA move together,
          // bound to the current reset epoch via the nonce in the file.
          const realSession = event.headers["x-opencode-session-id"] ?? event.sessionID ?? ""
          const realProject = event.headers["x-opencode-project"] ?? ""
          const wireSession = deriveWireId(realSession, fp.nonce, "ses")
          const wireProject = realProject ? deriveWireId(realProject, fp.nonce, "prj") : undefined

          event.headers["x-opencode-session-id"] = wireSession
          event.headers["x-session-affinity"] = wireSession
          event.headers["X-Session-Id"] = wireSession
          event.headers["x-opencode-session"] = wireSession
          delete event.headers["x-opencode-parent-session-id"]
          delete event.headers["x-parent-session-id"]
          if (wireProject) event.headers["x-opencode-project"] = wireProject
          else delete event.headers["x-opencode-project"]

          event.headers["User-Agent"] = fp.ua
          event.headers["user-agent"] = fp.ua
          event.headers["x-opencode-client"] = fp.clientLabel
          // DIAG: log the full outgoing header set so we can see what
          // opencode.ai actually receives on each request. The `authorization`
          // field is captured in full — if the sidecar is still sending
          // `Bearer public`, that's a critical observation and redacting it
          // defeats the purpose of the diagnostic.
          try {
            const headerSnapshot: Record<string, string> = {}
            for (const [k, v] of Object.entries(event.headers)) {
              if (typeof v === "string") headerSnapshot[k] = v
            }
            diag(`[ua-spoof] outgoing headers for ${event.baseURL}: ${JSON.stringify(headerSnapshot)}`)
          } catch { /* ignore */ }
          return
        }

        // No fingerprint file — fall back to env-var opt-in behaviour so
        // installs that have never hit Reset keep behaving like upstream +
        // whatever the user set manually.
        if (!loggedApply) {
          loggedApply = true
          yield* Effect.logInfo("devcode-ua-spoof: NO fingerprint loaded, headers pass through", {
            fallback_spoof_session: FALLBACK_SPOOF_SESSION,
            fallback_spoof_ua: FALLBACK_SPOOF_UA,
          })
        }
        if (FALLBACK_SPOOF_SESSION) {
          const id = freshSessionID()
          event.headers["x-opencode-session-id"] = id
          event.headers["x-session-affinity"] = id
          event.headers["X-Session-Id"] = id
          event.headers["x-opencode-session"] = id
          delete event.headers["x-opencode-parent-session-id"]
          delete event.headers["x-parent-session-id"]
          delete event.headers["x-opencode-project"]
        }
        if (FALLBACK_SPOOF_CLIENT) {
          // Mint a fresh install id per request. Live logs showed the compiled
          // sidecar re-emitted the SAME `x-opencode-client=oc-a1a66da545b1`
          // across pill-click boundaries; replacing it per request kills that
          // identity carry even when the stable fingerprint file didn't rotate.
          const freshClient = "oc-" + randomBytes(6).toString("hex")
          event.headers["x-opencode-client"] = freshClient
          delete event.headers["x-opencode-install-id"]
          delete event.headers["x-opencode-device-id"]
          delete event.headers["x-opencode-machine-id"]
          delete event.headers["x-opencode-hwid"]
          delete event.headers["x-install-id"]
          delete event.headers["x-device-id"]
        }
        if (FALLBACK_SPOOF_UA) {
          const ua = pickFallbackUA(event.sessionID)
          event.headers["User-Agent"] = ua
          event.headers["user-agent"] = ua
          if (!FALLBACK_SPOOF_CLIENT) delete event.headers["x-opencode-client"]
        }
      }).pipe(Effect.catch(() => Effect.void))
    yield* ctx.session.hook("model.request", hook)
  }),
})
