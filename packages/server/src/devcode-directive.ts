// DevCode server-authoritative reset: directive client.
//
// Lives in @opencode/server because the Usage reset handler calls it from
// the sidecar. The pubkey is the SAME one the CLI's licensing engine
// verifies license tokens with — injected at build time via the Bun
// --define DEVCODE_LICENSE_PUBKEY flag (base64-encoded SPKI PEM).
//
// Flow:
//   1. Caller passes the cached license.json contents.
//   2. We TLS-pin a POST to /exec/reset-directive on the license Worker.
//   3. On 200 we verify the Ed25519 signature with the baked pubkey.
//   4. We check type / exp / key-prefix / hwid-prefix match before trusting.
//   5. We return the recipe payload for the caller to apply.
//
// Any failure in 2-4 => refuseal reason, caller returns 403 to renderer
// and the local reset NEVER runs.

import crypto from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import tls from "node:tls"

declare const DEVCODE_LICENSE_PUBKEY: string | undefined
const EMBEDDED_PUBKEY =
  (typeof DEVCODE_LICENSE_PUBKEY === "string" && DEVCODE_LICENSE_PUBKEY) || "dev-pubkey-replace"

// Mirror of the CLI's cache-salt define. The sidecar handler ends up
// inside the same opencode-cli.exe binary as the CLI's licensing module,
// so one define flows into both. Must match byte-for-byte or the
// loadCachedLicense path below fails HKDF-derive and every Reset click
// returns "not activated" even on a legit install.
declare const DEVCODE_CACHE_SALT: string | undefined
const CACHE_SALT =
  (typeof DEVCODE_CACHE_SALT === "string" && DEVCODE_CACHE_SALT) || "dev-cache-salt-replace"
const CACHE_MAGIC = Buffer.from("OLEC1")

// Same pin set as the licensing engine. If one rotates the client is dead
// until the next build; that's intended — the reset should ride the same
// trust anchor the license does.
const ACCEPTED_PINS: ReadonlySet<string> = new Set([
  "/E2cKMmfCluBe5uiOkieUIqGnCbFVWbKV4MYbq+dLhA=",
  "kIdp6NNEd8wsugYyyIYFsi1ylMCED3hZbSR8ZFsa/A4=",
])

export class DirectiveError extends Error {
  readonly _tag = "DirectiveError"
}

export interface DirectivePayload {
  type: "reset-directive-v1"
  k_prefix: string
  h_prefix: string
  n: string
  e: number
  r: {
    version?: number
    ops: Array<{ op: string; args?: unknown }>
  }
}

let cachedPubKey: crypto.KeyObject | undefined
function loadPubKey(): crypto.KeyObject {
  if (cachedPubKey) return cachedPubKey
  const pem = Buffer.from(EMBEDDED_PUBKEY, "base64").toString("utf8")
  cachedPubKey = crypto.createPublicKey(pem)
  return cachedPubKey
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

function verifyPinnedChain(cert: tls.DetailedPeerCertificate): Error | undefined {
  if (!cert || typeof cert !== "object") return new Error("tls: no peer cert")
  const seen = new Set<string>()
  let node: tls.DetailedPeerCertificate = cert
  while (node && !seen.has(node.fingerprint)) {
    seen.add(node.fingerprint)
    try {
      const x509 = new crypto.X509Certificate(node.raw)
      const spkiDer = x509.publicKey.export({ type: "spki", format: "der" }) as Buffer
      const pin = crypto.createHash("sha256").update(spkiDer).digest("base64")
      if (ACCEPTED_PINS.has(pin)) return undefined
    } catch {
      // continue walking
    }
    const next = node.issuerCertificate
    if (!next || next === node) break
    node = next
  }
  return new Error("tls: pin mismatch")
}

function pinnedPostJson<T>(url: string, body: unknown, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      reject(new DirectiveError("bad license-api URL"))
      return
    }
    const data = Buffer.from(JSON.stringify(body ?? {}), "utf8")
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(data.length),
          "user-agent": "devcode-sidecar-directive",
        },
        timeout: timeoutMs,
        checkServerIdentity: (host, cert) => {
          const identityErr = tls.checkServerIdentity(host, cert)
          if (identityErr) return identityErr
          return verifyPinnedChain(cert as tls.DetailedPeerCertificate)
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c as Buffer))
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8")
            const parsed = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string })
            if (res.statusCode && res.statusCode >= 400) {
              reject(new DirectiveError(parsed.error ?? `HTTP ${res.statusCode}`))
              return
            }
            resolve(parsed as T)
          } catch (err) {
            reject(new DirectiveError((err as Error).message))
          }
        })
      },
    )
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", (err) => reject(new DirectiveError(err.message)))
    req.write(data)
    req.end()
  })
}

export interface Cached {
  readonly key: string
  readonly token: string
  readonly hwid: string
  readonly tier: string
  readonly expires_at: number
}

export interface DirectiveResult {
  payload: DirectivePayload
  // Raw token so we can log it or stash it to disk for the launcher.
  raw: string
  // The server-reported expiry (unix seconds) — used for the "stale cache"
  // tolerance window the client falls back to on Worker unreachability.
  exp: number
}

const DEFAULT_API = "https://license.example.com"

export async function fetchResetDirective(cached: Cached): Promise<DirectiveResult> {
  const apiBase = process.env.DEVCODE_LICENSE_API ?? DEFAULT_API
  const resp = await pinnedPostJson<{ ok: boolean; directive?: string; exp?: number; error?: string }>(
    `${apiBase}/exec/reset-directive`,
    { key: cached.key, hwid: cached.hwid },
  )
  if (!resp.ok || !resp.directive) {
    throw new DirectiveError(resp.error ?? "directive refused")
  }
  const dot = resp.directive.indexOf(".")
  if (dot < 0) throw new DirectiveError("malformed directive")
  const payloadB64 = resp.directive.slice(0, dot)
  const sigB64 = resp.directive.slice(dot + 1)
  const sig = b64urlDecode(sigB64)
  const payloadBytes = Buffer.from(payloadB64, "utf8")
  const ok = crypto.verify(null, payloadBytes, loadPubKey(), sig)
  if (!ok) throw new DirectiveError("directive signature invalid")

  let payload: DirectivePayload
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as DirectivePayload
  } catch {
    throw new DirectiveError("directive payload not JSON")
  }

  if (payload.type !== "reset-directive-v1") {
    throw new DirectiveError(`directive wrong type: ${payload.type}`)
  }
  if (!payload.e || payload.e * 1000 < Date.now()) {
    throw new DirectiveError("directive expired")
  }
  if (payload.k_prefix !== cached.key.slice(0, 5)) {
    throw new DirectiveError("directive bound to a different key")
  }
  if (payload.h_prefix !== cached.hwid.slice(0, 16)) {
    throw new DirectiveError("directive bound to a different hwid")
  }
  if (!payload.r || !Array.isArray(payload.r.ops) || payload.r.ops.length === 0) {
    throw new DirectiveError("directive has no ops")
  }

  return { payload, raw: resp.directive, exp: payload.e }
}

// HWID formula mirror. Must match overlay/packages/cli/src/services/
// licensing.ts platformHwid() byte-for-byte -- we feed it to the same
// HKDF to derive the cache decryption key. A diff here means every
// Reset click fails with "not activated" on a legit install.
function hashId(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32)
}
function readWindowsMachineGuidSidecar(): string | undefined {
  if (process.platform !== "win32") return undefined
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  const r = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (r.status !== 0 || !r.stdout) return undefined
  const match = r.stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/)
  return match?.[1]
}
function hwidPrimary(): string {
  if (process.platform === "win32") {
    const g = readWindowsMachineGuidSidecar()
    if (g) return hashId(`win:${g}`)
  }
  if (process.platform === "linux") {
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      if (fs.existsSync(p)) {
        const id = fs.readFileSync(p, "utf8").trim()
        if (id) return hashId(`linux:${id}`)
      }
    }
  }
  if (process.platform === "darwin") {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const r = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", windowsHide: true })
    const m = r.stdout?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    if (m) return hashId(`mac:${m[1]}`)
  }
  return hashId(`fallback:${os.hostname()}:${os.userInfo().username}`)
}
function hwidSecondary(): string {
  const cpu = os.cpus()[0]?.model?.trim() ?? "unknown-cpu"
  const ramGb = Math.round(os.totalmem() / 1024 / 1024 / 1024)
  return hashId(`anchor2:${process.platform}:${process.arch}:${cpu}:${ramGb}G:${os.release()}`)
}
function sidecarHwid(): string {
  return `${hwidPrimary()}.${hwidSecondary()}`
}

function deriveCacheKey(hwid: string): Buffer {
  const ikm = Buffer.from(hwid, "utf8")
  const salt = Buffer.from(CACHE_SALT, "utf8")
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("devcode-cache-v1"), 32))
}

function decryptCache(buf: Buffer, hwid: string): Cached | null {
  try {
    if (buf.length < 5 + 1 + 12 + 16) return null
    if (buf.compare(CACHE_MAGIC, 0, 5, 0, 5) !== 0) return null
    const version = buf[5]
    if (version !== 1) return null
    const iv = buf.subarray(6, 18)
    const tag = buf.subarray(18, 34)
    const ct = buf.subarray(34)
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveCacheKey(hwid), iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return JSON.parse(pt.toString("utf8")) as Cached
  } catch {
    return null
  }
}

// Load the cached license.json. The CLI's licensing module writes this at
// activate time; the sidecar reads it here to authenticate the directive
// request. Returns null if missing / unparseable so the caller can emit a
// clear "not activated" error without crashing.
//
// Format detection: a plaintext JSON file starts with `{` (0x7b); an
// encrypted file starts with the CACHE_MAGIC `OLEC1` (0x4F). Branch on
// the first byte so legacy plaintext caches from v3 still load during
// an upgrade.
export function loadCachedLicense(cachePath: string): Cached | null {
  try {
    if (!fs.existsSync(cachePath)) return null
    const raw = fs.readFileSync(cachePath)
    if (raw.length === 0) return null
    let parsed: Cached | null
    if (raw[0] === 0x7b /* '{' */) {
      try {
        parsed = JSON.parse(raw.toString("utf8")) as Cached
      } catch {
        return null
      }
    } else {
      parsed = decryptCache(raw, sidecarHwid())
    }
    if (!parsed || !parsed.key || !parsed.hwid) return null
    return parsed
  } catch {
    return null
  }
}

// Whitelist of ops the client knows how to apply. Any op not in this map
// is dropped on the floor; the sidecar logs it and continues. This keeps
// a compromised server from being able to execute arbitrary code — it
// can only drive operations the client already does.
export const KNOWN_OPS = new Set(["delete_tables", "clear_storage", "rotate_egress"])

// ---------------------------------------------------------------------------
// Standalone directive-token verification + nonce-ledger. Used by the
// `/_devcode/reset-limits` deep path and by any future route that wants to
// gate destructive ops behind a signed, single-use authorization token.
//
// The threat model this closes: a reverser who read the broken fresh.ps1 and
// reset-limits.ts, extracted the DB-wipe primitives into a standalone .bat,
// and used it to bypass the directive flow entirely. With reset-limits.ts
// deleted and this gate in place, the ONLY code path that can wipe the DB
// lives inside the compiled opencode-cli binary (string-sealed, obfuscated)
// and only runs when handed a valid signed directive bound to the live
// license + hwid. A pirate needs:
//   * a valid license to get a directive from the Worker (HWID-bound),
//   * to NOT reuse a nonce (ledger blocks replay),
//   * to NOT forge a directive (needs the Worker's private Ed25519 key).
// All three are enforced here.
// ---------------------------------------------------------------------------

export interface VerifiedDirective {
  payload: DirectivePayload
  raw: string
}

// Decode + Ed25519-verify a directive token against the baked pubkey. Pure —
// does not touch disk, does not touch the nonce ledger. Returns null on any
// malformed / expired / sig-invalid input so callers can emit a uniform
// 403 without leaking which check failed.
export function verifyDirectiveToken(token: string | undefined): VerifiedDirective | null {
  if (!token || typeof token !== "string") return null
  const dot = token.indexOf(".")
  if (dot < 1) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  if (!payloadB64 || !sigB64) return null
  let sig: Buffer
  let payload: DirectivePayload
  try {
    sig = b64urlDecode(sigB64)
    const payloadBytes = Buffer.from(payloadB64, "utf8")
    if (!crypto.verify(null, payloadBytes, loadPubKey(), sig)) return null
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as DirectivePayload
  } catch {
    return null
  }
  if (payload?.type !== "reset-directive-v1") return null
  if (!payload.e || payload.e * 1000 < Date.now()) return null
  // Max forward skew — a directive claiming exp more than TTL*8 ahead is
  // either a server bug or a crafted token. Refuse.
  if (payload.e * 1000 > Date.now() + 480_000) return null
  if (!payload.n || typeof payload.n !== "string") return null
  return { payload, raw: token }
}

// Match the launcher-side nonce ledger used in scripts/fresh.ps1 so a single
// directive issued by the Worker burns the same way whether it's consumed by
// the PowerShell launcher or by this sidecar handler. Path:
//   $XDG_STATE_HOME/opencode/consumed-nonces.log   (defaults to
//   $HOME/.local/state/opencode/consumed-nonces.log on win32 the HOME fallback
//   is %USERPROFILE%).
// Line format: "<unix-seconds> <nonce>". Pruned on every read to anything
// newer than 4 minutes (4× the 60s directive TTL), matching fresh.ps1.
function resolveNonceLedger(): string {
  const state =
    process.env.XDG_STATE_HOME ||
    (process.platform === "win32"
      ? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.local\\state` : undefined)
      : `${os.homedir()}/.local/state`)
  if (!state) throw new Error("cannot resolve XDG_STATE_HOME for nonce ledger")
  const dir = `${state}${state.includes("\\") ? "\\" : "/"}opencode`
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* existing / race / permission — handled on write */
  }
  return `${dir}${state.includes("\\") ? "\\" : "/"}consumed-nonces.log`
}

// Atomic check-and-record. Returns `true` if the nonce was NOT present and has
// now been recorded (caller may proceed with the destructive op). Returns
// `false` if the nonce was already consumed OR the write failed — in both
// cases the caller MUST refuse. Writing happens before the op so a crash in
// the op itself still burns the nonce, matching single-use semantics.
export function consumeNonce(nonce: string): boolean {
  if (!nonce) return false
  const path = resolveNonceLedger()
  const cutoff = Math.floor(Date.now() / 1000) - 240
  let seen = false
  const kept: string[] = []
  try {
    if (fs.existsSync(path)) {
      const text = fs.readFileSync(path, "utf8")
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^(\d+)\s+(.+)$/)
        if (!m) continue
        const ts = Number(m[1])
        if (!Number.isFinite(ts) || ts < cutoff) continue
        kept.push(line)
        if (m[2] === nonce) seen = true
      }
    }
  } catch {
    // Read failure is treated as "unknown state" — refuse the op so a
    // transient disk hiccup can never under-check a replay.
    return false
  }
  if (seen) {
    // Rewrite to prune even on refusal so the ledger stays bounded.
    try {
      fs.writeFileSync(path, kept.join("\n") + (kept.length ? "\n" : ""), "utf8")
    } catch {
      /* best-effort */
    }
    return false
  }
  const now = Math.floor(Date.now() / 1000)
  kept.push(`${now} ${nonce}`)
  try {
    fs.writeFileSync(path, kept.join("\n") + "\n", "utf8")
  } catch {
    return false
  }
  return true
}

// Resolve the cached license path the sidecar reads at reset time. Must match
// the CLI licensing engine's writer at `${global.data}/license.json`.
export function resolveLicenseCachePath(): string {
  const data = process.env.XDG_DATA_HOME || (process.platform === "win32"
    ? `${process.env.USERPROFILE}\\.local\\share`
    : `${os.homedir()}/.local/share`)
  const sep = data.includes("\\") ? "\\" : "/"
  return `${data}${sep}opencode${sep}license.json`
}
