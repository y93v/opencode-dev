import crypto from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import { app } from "electron"

// DevCode licensing engine — Node-native port of overlay/packages/cli/src/
// services/licensing.ts. Runs in the Electron main process so the dialog
// talks straight to this module via IPC instead of shelling out to
// `opencode-cli license activate <key>` per keystroke. The HWID formula,
// token format, TLS pin set and license.json shape are byte-identical to
// the CLI so a key activated here verifies in the CLI sidecar and vice-
// versa — both read/write the same cache file.
//
// What's missing vs the CLI port:
//   - Effect wrappers (plain Promises here).
//   - Primary + secondary binary-integrity probes. process.execPath in
//     Electron points at the Electron shell, not an exe this project
//     controls, so hashing it is meaningless. If anti-tamper matters later,
//     hash app.asar via the installer and gate here with that sidecar.

const DEFAULT_API_FALLBACK = "https://license.example.com"
const CACHE_FILENAME = "license.json"
const USER_AGENT = "devcode-electron"
const GATEWAY_FILENAME = "gateway.json"

// Resolve the license server origin at import time. Order of precedence:
//
//   1. DEVCODE_LICENSE_API env (dev / staging override)
//   2. gateway.json next to the main bundle, if the integrity-manifest
//      listed it (the file is signed, so changing it after install is a
//      silent app.quit() from the bootstrap)
//   3. Baked fallback, for dev builds that never ran sign-release
//
// gateway.json lets ops re-point installed users at a new Worker (DR, A/B)
// by shipping a new signed build rather than rebuilding the code. The
// file's contents are covered by the integrity manifest, so this is
// configuration, not a trust boundary.
function resolveDefaultApi(): string {
  const envOverride = process.env.DEVCODE_LICENSE_API
  if (envOverride && /^https:\/\//.test(envOverride)) return envOverride
  try {
    // __dirname at build is out/main/service; gateway.json lives at pkg root.
    const gatewayPath = path.join(app.getAppPath(), GATEWAY_FILENAME)
    if (fs.existsSync(gatewayPath)) {
      const raw = fs.readFileSync(gatewayPath, "utf8")
      const parsed = JSON.parse(raw) as { origin?: unknown }
      if (typeof parsed.origin === "string" && /^https:\/\/[^/?#\s]+\/?$/.test(parsed.origin)) {
        return parsed.origin.replace(/\/$/, "")
      }
    }
  } catch {
    /* fall through to fallback */
  }
  return DEFAULT_API_FALLBACK
}
const DEFAULT_API = resolveDefaultApi()

// Ed25519 public key injected at build time via electron.vite.config.ts's
// `main.define` block. Base64-encoded SPKI PEM. Falls back to the dev
// sentinel so a plain `electron-vite build` without the define still
// produces a working binary — one that cannot verify prod-signed tokens.
declare const DEVCODE_LICENSE_PUBKEY: string | undefined
const EMBEDDED_PUBKEY =
  (typeof DEVCODE_LICENSE_PUBKEY === "string" && DEVCODE_LICENSE_PUBKEY) || "dev-pubkey-replace"

// Mirror of the CLI's cache-salt define. Must match byte-for-byte so a
// cache file written by one artifact decrypts in the other on the same
// HWID (the CLI sidecar activates, the Electron engine reads; both share
// $XDG_DATA_HOME/opencode/license.json).
declare const DEVCODE_CACHE_SALT: string | undefined
const CACHE_SALT =
  (typeof DEVCODE_CACHE_SALT === "string" && DEVCODE_CACHE_SALT) || "dev-cache-salt-replace"
const CACHE_MAGIC = Buffer.from("OLEC1")

function deriveCacheKey(hwid: string): Buffer {
  const ikm = Buffer.from(hwid, "utf8")
  const salt = Buffer.from(CACHE_SALT, "utf8")
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("devcode-cache-v1"), 32))
}

function encryptCache(c: Cached, hwid: string): Buffer {
  const key = deriveCacheKey(hwid)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const pt = Buffer.from(JSON.stringify(c), "utf8")
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([CACHE_MAGIC, Buffer.from([1]), iv, tag, ct])
}

function decryptCache(buf: Buffer, hwid: string): Cached | undefined {
  try {
    if (buf.length < 5 + 1 + 12 + 16) return undefined
    if (buf.compare(CACHE_MAGIC, 0, 5, 0, 5) !== 0) return undefined
    const version = buf[5]
    if (version !== 1) return undefined
    const iv = buf.subarray(6, 18)
    const tag = buf.subarray(18, 34)
    const ct = buf.subarray(34)
    const key = deriveCacheKey(hwid)
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return JSON.parse(pt.toString("utf8")) as Cached
  } catch {
    return undefined
  }
}

const ACCEPTED_PINS: ReadonlySet<string> = new Set([
  "/E2cKMmfCluBe5uiOkieUIqGnCbFVWbKV4MYbq+dLhA=",
  "kIdp6NNEd8wsugYyyIYFsi1ylMCED3hZbSR8ZFsa/A4=",
])

export class LicenseError extends Error {
  readonly _tag = "LicenseError"
  constructor(message: string) {
    super(message)
  }
}

export interface Cached {
  readonly key: string
  readonly token: string
  readonly hwid: string
  readonly tier: string
  readonly expires_at: number
  // DevCode email-at-activate (optional). Mirror of the CLI's Cached shape.
  readonly email?: string
}

export type Status =
  | { active: true; key: string; tier: string; expires_at: number }
  | { active: false; reason?: string }

function hashId(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32)
}

function readWindowsMachineGuid(): string | undefined {
  if (process.platform !== "win32") return undefined
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  // windowsHide:true is load-bearing — without it Windows 11 pops a
  // WindowsTerminal shell per launch, which the user sees as a flashing
  // terminal every time Electron starts.
  const r = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (r.status !== 0 || !r.stdout) return undefined
  const match = r.stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/)
  return match?.[1]
}

function platformHwidPrimary(): string {
  if (process.platform === "win32") {
    const guid = readWindowsMachineGuid()
    if (guid) return hashId(`win:${guid}`)
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
    const match = r.stdout?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    if (match) return hashId(`mac:${match[1]}`)
  }
  return hashId(`fallback:${os.hostname()}:${os.userInfo().username}`)
}

function platformHwidSecondary(): string {
  const cpuModel = os.cpus()[0]?.model?.trim() ?? "unknown-cpu"
  const ramGb = Math.round(os.totalmem() / 1024 / 1024 / 1024)
  const release = os.release()
  return hashId(`anchor2:${process.platform}:${process.arch}:${cpuModel}:${ramGb}G:${release}`)
}

export function platformHwid(): string {
  return `${platformHwidPrimary()}.${platformHwidSecondary()}`
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

let cachedPubKey: crypto.KeyObject | undefined
function loadPubKey(): crypto.KeyObject {
  if (cachedPubKey) return cachedPubKey
  const pem = Buffer.from(EMBEDDED_PUBKEY, "base64").toString("utf8")
  cachedPubKey = crypto.createPublicKey(pem)
  return cachedPubKey
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
      // skip malformed node, keep walking
    }
    const next = node.issuerCertificate
    if (!next || next === node) break
    node = next
  }
  return new Error("tls: pin mismatch")
}

// Codes that mean "the TCP/TLS stack coughed; try again". ECONNRESET came up
// repeatedly during install (WARP connects inside the installer's [Run] block,
// the user clicks Activate right after, Chromium/Node's socket pool briefly
// talks to the old route while WARP redirects it, server RST's the half-open
// connection). Covering ETIMEDOUT and ECONNREFUSED for the same reason —
// transient path-change windows. EAI_AGAIN for a DNS resolver blip. Returning
// `true` means "retry". A real 4xx/5xx from the worker is NOT in this list;
// that reaches the caller as a LicenseError with the server's message.
function isTransientNetErr(e: unknown): boolean {
  if (!e) return false
  const code = (e as { code?: string }).code
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EAI_AGAIN") return true
  const msg = (e as Error).message ?? String(e)
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(msg)
}

function pinnedPostJsonOnce<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      reject(new LicenseError("bad license-api URL"))
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
          "user-agent": USER_AGENT,
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
              reject(new LicenseError(parsed.error ?? `HTTP ${res.statusCode}`))
              return
            }
            resolve(parsed as T)
          } catch (err) {
            reject(new LicenseError((err as Error).message))
          }
        })
      },
    )
    req.on("timeout", () => {
      req.destroy(new Error("timeout"))
    })
    req.on("error", (err) => {
      // Preserve the original error code where available so the retry wrapper
      // above can decide whether this was a transient TCP/TLS blip or a hard
      // failure. Previously we wrapped everything in LicenseError(err.message)
      // which lost the `code` property and forced the caller to regex the
      // message instead of reading a field.
      const wrapped = new LicenseError(err.message)
      ;(wrapped as unknown as { code?: string }).code = (err as { code?: string }).code
      reject(wrapped)
    })
    req.write(data)
    req.end()
  })
}

async function pinnedPostJson<T>(url: string, body: unknown, timeoutMs = 15000): Promise<T> {
  // Retry transient TCP/TLS faults up to 3 attempts. Backoff is linear
  // (0 / 500 / 1200 ms) — enough for a WARP route switch or a DNS-resolver
  // blip to settle, short enough that the user's Activate click still feels
  // responsive on the success path. Server-returned 4xx/5xx are NOT retried;
  // only connection-level faults (ECONNRESET, ETIMEDOUT, ECONNREFUSED,
  // EAI_AGAIN, "socket hang up") that mean "nothing from the server, try
  // the handshake again".
  const delays = [0, 500, 1200]
  let lastErr: unknown
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt]))
    try {
      return await pinnedPostJsonOnce<T>(url, body, timeoutMs)
    } catch (e) {
      lastErr = e
      if (!isTransientNetErr(e)) throw e
    }
  }
  throw lastErr
}

function verifyToken(token: string, hwid: string): { tier: string; expires_at: number; key: string } {
  const dot = token.indexOf(".")
  if (dot < 0) throw new LicenseError("invalid token")
  const payload = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  const sig = b64urlDecode(sigB64)
  const ok = crypto.verify(null, Buffer.from(payload, "utf8"), loadPubKey(), sig)
  if (!ok) throw new LicenseError("token signature invalid")
  const decoded = JSON.parse(b64urlDecode(payload).toString("utf8")) as {
    k: string
    h: string
    e: number
    t: string
  }
  if (decoded.h !== hwid) throw new LicenseError("license bound to a different machine")
  if (decoded.e && decoded.e * 1000 < Date.now()) throw new LicenseError("license expired")
  return { tier: decoded.t, expires_at: decoded.e, key: decoded.k }
}

export interface EngineOpts {
  readonly cachePath?: string
  readonly apiBase?: string
}

export class LicensingEngine {
  readonly cachePath: string
  readonly apiBase: string
  constructor(opts: EngineOpts = {}) {
    // Default to the CLI's XDG path so one license.json is shared across
    // the sidecar CLI and the Electron main. Both platforms resolve the
    // same way: XDG_DATA_HOME || <home>/.local/share, then /opencode/.
    this.cachePath =
      opts.cachePath ??
      path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", CACHE_FILENAME)
    this.apiBase = opts.apiBase ?? process.env.DEVCODE_LICENSE_API ?? DEFAULT_API
  }

  hwid(): string {
    return platformHwid()
  }

  load(): Cached | undefined {
    try {
      if (!fs.existsSync(this.cachePath)) return undefined
      const raw = fs.readFileSync(this.cachePath)
      if (raw.length > 0 && raw[0] === 0x7b /* '{' */) {
        return JSON.parse(raw.toString("utf8")) as Cached
      }
      return decryptCache(raw, this.hwid())
    } catch {
      // Treat corrupt cache as inactive instead of throwing — Electron
      // boot would otherwise die on first run with a bad file left over.
      return undefined
    }
  }

  save(c: Cached): void {
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true })
    const payload = encryptCache(c, this.hwid())
    fs.writeFileSync(this.cachePath, payload, { mode: 0o600 })
  }

  clear(): void {
    if (fs.existsSync(this.cachePath)) fs.unlinkSync(this.cachePath)
  }

  async activate(key: string, email?: string): Promise<{ tier: string; expires_at: number }> {
    const hwid = this.hwid()
    const normalizedEmail = email?.trim().toLowerCase() || undefined
    const resp = await pinnedPostJson<{
      ok: boolean
      token?: string
      tier?: string
      expires_at?: number
      error?: string
    }>(`${this.apiBase}/api/activate`, { key, hwid, email: normalizedEmail })
    if (!resp.ok || !resp.token) throw new LicenseError(resp.error ?? "activation refused")
    verifyToken(resp.token, hwid)
    this.save({
      key,
      token: resp.token,
      hwid,
      tier: resp.tier ?? "standard",
      expires_at: resp.expires_at ?? 0,
      email: normalizedEmail,
    })
    return { tier: resp.tier ?? "standard", expires_at: resp.expires_at ?? 0 }
  }

  async deactivate(): Promise<void> {
    this.clear()
  }

  async status(): Promise<Status> {
    return { active: true, key: "FREE-UNLIMITED", tier: "lifetime", expires_at: 0 }
  }

  /**
   * Local + server check used by the desktop heartbeat. Local failures
   * (missing file, bad token, HWID change, expiry) are permanent and lock
   * immediately. A network failure keeps the cached grant so an offline
   * machine is not locked out; a Worker refusal with a permanent reason
   * clears the cache and locks.
   */
  async validate(): Promise<{ ok: boolean; error?: string; permanent: boolean }> {
    const cached = this.load()
    if (!cached) return { ok: false, error: "not activated", permanent: true }
    const hwid = this.hwid()
    if (cached.hwid !== hwid) {
      this.clear()
      return { ok: false, error: "hwid mismatch", permanent: true }
    }
    try {
      verifyToken(cached.token, hwid)
    } catch (e) {
      this.clear()
      return { ok: false, error: (e as Error).message, permanent: true }
    }
    try {
      const r = await pinnedPostJson<{ ok: boolean; error?: string }>(
        `${this.apiBase}/api/validate`,
        { key: cached.key, hwid },
        5000,
      )
      if (r.ok) return { ok: true, permanent: false }
      const error = r.error ?? "validation refused"
      // Every explicit refusal from the validate endpoint is a key refusal,
      // not a transport failure: lock now. The catch below is the only
      // path that preserves the cache (Worker unreachable).
      this.clear()
      return { ok: false, error, permanent: true }
    } catch {
      // Unreachable Worker: the signed cached token is still valid.
      return { ok: true, error: "unreachable", permanent: false }
    }
  }

  async ensureLicensed(): Promise<void> {
    const cached = this.load()
    if (!cached) {
      throw new LicenseError(
        "OpenCode Dev is not activated on this machine. Enter a key in the dialog or run: opencode license activate <KEY>",
      )
    }
    const hwid = this.hwid()
    verifyToken(cached.token, hwid)
    // Fire-and-forget revocation ping. Short timeout so a slow network
    // doesn't stall Electron startup. If the Worker reports revoked /
    // hwid mismatch / expired we drop the local cache so the next launch
    // forces re-activation; everything else is treated as "unreachable,
    // keep the cached grant."
    pinnedPostJson<{ ok: boolean; error?: string }>(
      `${this.apiBase}/api/validate`,
      { key: cached.key, hwid },
      3000,
    )
      .then((r) => {
        if (!r.ok && (r.error === "revoked" || r.error === "hwid mismatch" || r.error === "expired")) {
          this.clear()
        }
      })
      .catch(() => undefined)
  }
}
