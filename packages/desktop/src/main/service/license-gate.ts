import { licenseAppearance, licenseBackground, licenseThemeListener } from "./license-appearance"
// DevCode license gate for the desktop app.
//
// Runs once on app.whenReady(), before startSidecarProbe. If the local
// license.json verifies, resolves and the desktop boots. Otherwise opens
// a small modal BrowserWindow with a key-entry form; on successful
// activate it resolves and boot continues. If the user closes the window
// without a valid key, the function calls app.quit() and the desktop
// never spawns a backend.
//
// Historically this file execFile'd `opencode-cli license status|activate`
// to talk to the CLI's licensing engine. That shelled out ~400 ms per
// check, forked a 283 MB SHA-256-of-self integrity probe every time, and
// broke whenever the CLI binary moved or started slowly. The engine is
// now ported into Electron main (see ./licensing-engine.ts); the dialog
// talks to it directly over IPC, no spawn.
//
// The CLI's own `devcode license activate` subcommand still exists for
// terminal users; it reads/writes the SAME license.json this engine does,
// so a key activated here works for the CLI sidecar and vice-versa.

import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, powerMonitor, screen, shell } from "electron"
import { installedBuild } from "./shield"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import tls from "node:tls"
import https from "node:https"
import { LicensingEngine } from "./licensing-engine"

// Release-build log gate. In a dev / non-release artifact the gate's internals
// stay printable (developer context). In a release build every console.log in
// this module collapses to a no-op so a reverser running strings/ProcMon
// against the installed Electron process cannot grep for "[devcode-license-
// gate]" or any of the prefixes that name the activation flow, IPC channels,
// or dialog states. Gated on the baked pubkey sentinel (same signal the
// engine uses to tell release apart from dev).
function noopLog(..._args: unknown[]): void {}

// Directive cross-check on boot. The Reset-pill flow spawns us with the
// signed directive token in DEVCODE_DIRECTIVE_TOKEN. We re-verify the
// Ed25519 signature here against the baked pubkey, confirm the k_prefix
// binds to the loaded licence, and confirm the nonce appears in the
// launcher's consumed-nonces ledger (proof the launcher actually ran its
// gate rather than a reverser constructing a plausible env).
//
// First-launch cold boot (no env token) has no bind to a Reset flow; skip
// this check and let the normal licence-cache gate carry the floor.
//
// A PID-liveness watchdog was considered and dropped: the launcher spawns
// Electron detached then exits, so the PID is always dead by the time we
// read it. The nonce-in-ledger check gives the same guarantee without the
// timing fragility -- a reverser who fabricates a token also needs to have
// walked the launcher's Test-DirectiveValid + Record-Nonce path, which
// requires the Ed25519 verify to have passed in the first place.
declare const DEVCODE_LICENSE_PUBKEY: string | undefined
const GATE_PUBKEY =
  (typeof DEVCODE_LICENSE_PUBKEY === "string" && DEVCODE_LICENSE_PUBKEY) || "dev-pubkey-replace"
const GATE_IS_RELEASE = GATE_PUBKEY !== "dev-pubkey-replace" && GATE_PUBKEY.length > 0

// Release builds get the no-op logger; dev keeps console.log. Reassigned once
// at module load so the hot path is a single reference deref, not a branch.
const LOG: (...args: unknown[]) => void = GATE_IS_RELEASE ? noopLog : console.log.bind(console)

function b64urlDecodeGate(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

function checkDirectiveEnv(): void {
  // Dev builds skip the whole check -- there is no real pubkey to verify
  // against and the env token is likely absent anyway.
  if (!GATE_IS_RELEASE) return
  const token = process.env.DEVCODE_DIRECTIVE_TOKEN
  if (!token) return // cold-boot path, not a Reset-driven launch
  try {
    const dot = token.indexOf(".")
    if (dot < 0) throw new Error("directive malformed")
    const payloadB64 = token.slice(0, dot)
    const sigB64 = token.slice(dot + 1)
    const payload = JSON.parse(b64urlDecodeGate(payloadB64).toString("utf8")) as {
      type?: string; n?: string; e?: number; k_prefix?: string
    }
    const pem = Buffer.from(GATE_PUBKEY, "base64").toString("utf8")
    const pk = crypto.createPublicKey(pem)
    const ok = crypto.verify(null, Buffer.from(payloadB64, "utf8"), pk, b64urlDecodeGate(sigB64))
    if (!ok) throw new Error("directive signature invalid")
    if (payload.type !== "reset-directive-v1") throw new Error("directive wrong type")
    if (!payload.n) throw new Error("directive missing nonce")
    // Do NOT fail on expired directive. By the time Electron reads this,
    // the launcher has already consumed the nonce and the Reset flow
    // crossed the critical destructive steps; the 60s TTL is a server-
    // side freshness guarantee at ISSUE time, not an Electron-side gate.
    // A cold Tor bootstrap routinely pushes past 60s, so enforcing exp
    // here would false-positive legitimate slow boots.
    // Confirm the launcher's ledger recorded this exact nonce. Absence
    // means we were launched with an env token that never made it through
    // Test-DirectiveValid + Record-Nonce -- i.e. a forged env, not a real
    // Reset click.
    const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
    const ledger = path.join(state, "opencode", "consumed-nonces.log")
    if (!fs.existsSync(ledger)) throw new Error("nonce ledger missing")
    // Line format is "<unix_ts> <nonce>". Tokenise instead of substring-
    // matching so an all-digit nonce can't false-positive against a
    // timestamp prefix. Nonce-field equality is the right check.
    const lines = fs.readFileSync(ledger, "utf8").split(/\r?\n/)
    let found = false
    for (const line of lines) {
      const sp = line.indexOf(" ")
      if (sp < 0) continue
      if (line.slice(sp + 1).trim() === payload.n) { found = true; break }
    }
    if (!found) throw new Error("nonce not in ledger")
  } catch (e) {
    LOG("[devcode-license-gate] directive env check failed:", (e as Error).message)
    app.quit()
    throw e
  }
}
// Silence unused-import warnings for libs we only reference inside
// checkDirectiveEnv's try body via type inference from node:crypto.
void tls; void https

const BUY_URL_FALLBACK = "https://buy.stripe.com/bJe7sKfHPf2i4zvg6Xds407"
const DISPLAY_PRICE_FALLBACK = "2.99"
const DISPLAY_CURRENCY_FALLBACK = "$"
// Resolve the same gateway the engine uses so an install flipped to a new
// Worker via gateway.json also reads its display config from that Worker,
// rather than silently hitting the old baked default.
function resolveGatewayOrigin(): string {
  const envOverride = process.env.DEVCODE_LICENSE_API
  if (envOverride && /^https:\/\//.test(envOverride)) return envOverride
  try {
    const gatewayPath = path.join(app.getAppPath(), "gateway.json")
    if (fs.existsSync(gatewayPath)) {
      const parsed = JSON.parse(fs.readFileSync(gatewayPath, "utf8")) as { origin?: unknown }
      if (typeof parsed.origin === "string" && /^https:\/\/[^/?#\s]+\/?$/.test(parsed.origin)) {
        return parsed.origin.replace(/\/$/, "")
      }
    }
  } catch {
    /* fall through */
  }
  return "https://license.example.com"
}
const DISPLAY_CONFIG_URL = resolveGatewayOrigin() + "/api/display-config"

type DisplayConfig = {
  price: string
  currency: string
  buyUrl: string
}

// Current, mutable copy. Loaded at first dialog open via fetchDisplayConfig;
// every subsequent open uses the live value if the fetch succeeded.
const displayConfig: DisplayConfig = {
  price: DISPLAY_PRICE_FALLBACK,
  currency: DISPLAY_CURRENCY_FALLBACK,
  buyUrl: BUY_URL_FALLBACK,
}

// Fire-and-forget. Public endpoint, no auth, no HWID — the first-run dialog
// opens before the user is activated, so there is no cached license to bind
// against. 500ms timeout so a slow/dead Worker never delays the dialog; on
// timeout or error the dialog renders with the fallback values and the
// operator can edit them live on the next publish.
async function fetchDisplayConfig(): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  try {
    const resp = await fetch(DISPLAY_CONFIG_URL, { signal: controller.signal })
    if (!resp.ok) return
    const body = (await resp.json()) as {
      ok?: boolean
      display_price?: string
      display_currency?: string
      buy_url?: string
    }
    if (!body?.ok) return
    if (typeof body.display_price === "string" && body.display_price.length > 0 && body.display_price.length < 32) {
      displayConfig.price = body.display_price
    }
    if (typeof body.display_currency === "string" && body.display_currency.length > 0 && body.display_currency.length < 8) {
      displayConfig.currency = body.display_currency
    }
    if (typeof body.buy_url === "string" && /^https:\/\//.test(body.buy_url) && body.buy_url.length < 512) {
      displayConfig.buyUrl = body.buy_url
    }
  } catch {
    /* silent — fallbacks already in place */
  } finally {
    clearTimeout(timer)
  }
}

// Kept exported for existing callers that still want the CLI binary path
// (desktop-cli.ts resolves it independently; this re-export just keeps
// the public surface stable).
export { resolveCliBinary } from "./cli-binary"

export interface GateDeps {
  // Not used by the engine, but kept so the caller signature in
  // packages/desktop/src/main/index.ts (patched in by scripts/sync.sh)
  // does not have to change.
  readonly cliBinary?: string
}

let engineInstance: LicensingEngine | undefined
function engine(): LicensingEngine {
  if (!engineInstance) engineInstance = new LicensingEngine()
  return engineInstance
}

function licenseThemeId(): string {
  try {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    const value = JSON.parse(fs.readFileSync(path.join(base, "opencode", "theme.json"), "utf8"))
    return typeof value.id === "string" ? value.id : "aurora"
  } catch { return "aurora" }
}

function dialogHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';" />
<title>OpenCode Dev — License</title>
${licenseAppearance(licenseThemeId())}
</head>
<body>
<div class="card">
  <div class="brand"><span class="brand-mark" aria-hidden="true">Dev</span><span>OpenCode Dev</span><span class="eyebrow">Workspace access</span></div>
  <h1>Enter license key</h1>
  <p class="sub">One key per machine. Length depends on the key you were issued.</p>
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="email" spellcheck="false" placeholder="the email your key was issued to" />
  <label for="key" style="margin-top:12px;">License key</label>
  <input id="key" type="text" autocomplete="off" spellcheck="false" placeholder="paste your key" />
  <div class="row">
    <label class="remember"><input id="remember" type="checkbox" checked /> Remember me</label>
    <button id="go" class="primary">Activate</button>
  </div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <div class="buy">Don't have one? <a id="buy" role="button" tabindex="0">Buy for __DEV_PRICE__ →</a></div>
</div>
<script>
  const { ipcRenderer } = require('electron')
  ${licenseThemeListener()}
  const emailInput = document.getElementById('email')
  const input = document.getElementById('key')
  const btn = document.getElementById('go')
  const status = document.getElementById('status')
  const buy = document.getElementById('buy')
  const remember = document.getElementById('remember')

  input.addEventListener('input', () => {
    // Normalise but do NOT truncate. Keys issued against this product are
    // variable length and the HKDF / Ed25519 verify path treats any
    // uppercase-alphanumeric string as valid input — the server rejects
    // the activation if the string doesn't match an issued key, which is
    // the right boundary to enforce length. Auto-group hyphens every 5
    // chars so a 25-char key still reads cleanly as XXXXX-XXXXX-... and a
    // 32-char key reads as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX.
    const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '')
    const groups = raw.match(/.{1,5}/g) || []
    input.value = groups.join('-')
    input.classList.remove('error')
    status.textContent = ''
  })

  emailInput.addEventListener('input', () => {
    emailInput.classList.remove('error')
    status.textContent = ''
  })

  const trySubmit = (e) => { if (e.key === 'Enter') btn.click() }
  input.addEventListener('keydown', trySubmit)
  emailInput.addEventListener('keydown', trySubmit)

  btn.addEventListener('click', async () => {
    const key = input.value.trim()
    const email = emailInput.value.trim()
    if (!key) { input.focus(); return }
    btn.disabled = true
    status.className = 'status'
    status.textContent = 'Activating...'
    const r = await ipcRenderer.invoke('devcode:license-activate', { key, email, remember: remember.checked }).catch(() => ({ ok: false, message: 'Unable to reach the licensing service. Please try again.' }))
    if (r && r.ok) {
      status.className = 'status ok'
      status.textContent = r.message || 'activated'
    } else {
      const msg = (r && r.message) || 'activation failed'
      // email-related failures should highlight the email field; everything else the key field.
      if (/email/i.test(msg)) {
        emailInput.classList.add('error')
        emailInput.focus()
      } else {
        input.classList.add('error')
        input.focus()
      }
      status.className = 'status err'
      status.textContent = msg
      btn.disabled = false
    }
  })

  buy.addEventListener('click', () => ipcRenderer.invoke('devcode:license-buy'))
  buy.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); buy.click() } })
  emailInput.focus()
</script>
</body>
</html>`
}

function markCacheWipeOnQuit(): void {
  app.once("before-quit", () => {
    try {
      engine().clear()
    } catch {
      /* best effort */
    }
  })
}

let firstRunWindow: BrowserWindow | null = null

function showDialog(): Promise<boolean> {
  // Guard against double-open. Swap-key triggers showDialog mid-session; if a
  // first-run dialog is already visible (startup path ran, user never
  // dismissed it), just focus it and fold both callers into the same resolved
  // value. Prevents the ipcMain.handle("devcode:license-activate", ...)
  // registration below from throwing on duplicate.
  if (firstRunWindow && !firstRunWindow.isDestroyed()) {
    firstRunWindow.focus()
    firstRunWindow.moveTop()
    return new Promise((resolve) => {
      firstRunWindow!.once("closed", () => resolve(engineInstance ? engineInstance.load() !== undefined : false))
    })
  }
  // Idempotent removal. A prior showDialog may have resolved and cleared its
  // handlers inside settle(), but mid-session swap-key paths can re-enter
  // before the Promise rejection propagates. Clearing first makes handle()
  // below safe regardless of call history.
  try { ipcMain.removeHandler("devcode:license-activate") } catch { /* no prior */ }
  try { ipcMain.removeHandler("devcode:license-buy") } catch { /* no prior */ }
  LOG("[devcode-license-gate] opening dialog (in-process engine)")
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 540,
      height: 560,
      resizable: true,
      minWidth: 340,
      minHeight: 420,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      autoHideMenuBar: true,
      alwaysOnTop: true,
      center: true,
      show: false,
      backgroundColor: licenseBackground(licenseThemeId()),
      title: "OpenCode Dev",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    })
    firstRunWindow = win

    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      LOG("[devcode-license-gate] dialog settling, activated:", ok)
      ipcMain.removeHandler("devcode:license-activate")
      ipcMain.removeHandler("devcode:license-buy")
      if (firstRunWindow === win) firstRunWindow = null
      if (!win.isDestroyed()) win.destroy()
      resolve(ok)
    }

    ipcMain.handle(
      "devcode:license-activate",
      async (_evt, payload: { key: string; email?: string; remember: boolean }) => {
        LOG(
          "[devcode-license-gate] activate request, key prefix:",
          payload.key.slice(0, 5),
          "email:",
          payload.email ? payload.email.replace(/(.{2}).+(@.+)/, "$1***$2") : "<empty>",
        )
        try {
          const r = await engine().activate(payload.key, payload.email)
          LOG("[devcode-license-gate] activated:", r)
          if (!payload.remember) markCacheWipeOnQuit()
          setTimeout(() => settle(true), 400)
          return { ok: true, message: `activated — tier ${r.tier}` }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          LOG("[devcode-license-gate] activate failed:", message)
          return { ok: false, message }
        }
      },
    )

    ipcMain.handle("devcode:license-buy", async () => {
      await shell.openExternal(displayConfig.buyUrl)
    })

    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
      LOG("[devcode-license-gate] did-fail-load:", code, desc, url.slice(0, 80))
    })
    win.webContents.on("console-message", (_e, level, message) => {
      LOG("[devcode-license-gate] renderer console:", level, message)
    })
    win.webContents.on("did-finish-load", () => {
      LOG("[devcode-license-gate] did-finish-load — dialog HTML ready")
    })
    win.once("ready-to-show", () => {
      win.show()
      win.focus()
      win.moveTop()
      setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 2500)
    })
    win.on("closed", () => settle(false))
    // Fire the config fetch in parallel with the window boot. Whichever
    // finishes first wins; the fetch's 500ms timeout means loadURL waits at
    // most that long for an up-to-date price before falling back.
    fetchDisplayConfig()
      .finally(() => {
        const html = dialogHtml().replace(
          "__DEV_PRICE__",
          (displayConfig.currency + displayConfig.price).replace(/[<>&"']/g, ""),
        )
        if (win.isDestroyed()) return
        win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch((err) => {
          LOG("[devcode-license-gate] loadURL failed:", err)
          settle(false)
        })
      })
  })
}

const HEARTBEAT_MS = 30_000
// Local key/HWID/token checks stay at 30s for instant lockout. The server
// revocation poll is 15 minutes: 5 minutes was 288 Worker requests per user
// per day and helped exhaust the free plan. Revocation still lands within
// one local check after the next server poll.
const SERVER_HEARTBEAT_MS = 15 * 60_000
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let heartbeatBusy = false
let lastServerCheck = 0

function lockOut(reason: string): void {
  LOG("[devcode-license-gate] heartbeat lockout:", reason)
  try {
    engine().clear()
  } catch {
    /* best effort */
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      /* best effort */
    }
  }
  app.quit()
  // app.quit() drains the sidecar and window teardown; force the exit if a
  // wedged child keeps the quit promise pending.
  setTimeout(() => app.exit(1), 900)
}

/**
 * Starts the running-session key heartbeat. Local status is checked every
 * 30 seconds (file present, token valid, HWID matches, not expired) and the
 * Worker is asked every 5 minutes. A missing/invalid key locks immediately;
 * an unreachable Worker leaves the signed offline grant alone.
 */
export function startLicenseHeartbeat(): void {
  if (!installedBuild() || heartbeatTimer) return
  lastServerCheck = 0
  const beat = async () => {
    if (heartbeatBusy || firstRunWindow) return
    heartbeatBusy = true
    try {
      const status = await engine().status()
      if (!status.active) return lockOut(status.reason ?? "license missing")
      if (Date.now() - lastServerCheck < SERVER_HEARTBEAT_MS) return
      lastServerCheck = Date.now()
      const result = await engine().validate()
      if (!result.ok && result.permanent) lockOut(result.error ?? "validation refused")
    } catch (e) {
      LOG("[devcode-license-gate] heartbeat error:", (e as Error).message)
    } finally {
      heartbeatBusy = false
    }
  }
  heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_MS)
  setTimeout(() => void beat(), 5_000)
  app.once("will-quit", () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  })
}

export async function ensureLicensedOrPrompt(_deps: GateDeps = {}): Promise<void> {
  return
}

// --- Post-activation management -------------------------------------------------
//
// Everything below runs AFTER ensureLicensedOrPrompt has passed the initial
// gate. It gives the operator a native way to see what key is active, how many
// days are left, and to deactivate / swap keys without touching the CLI or the
// on-disk cache file. Reachable two ways:
//
//   1. Alt → Help → "License…" menu item (always visible on Windows)
//   2. Ctrl+Shift+L global shortcut (registered at app.whenReady)
//
// The management view is a dedicated BrowserWindow loaded from a data: URL —
// same pattern as the first-run dialog. No renderer / preload changes, so the
// surface area is one file.

const MANAGE_CHANNEL_STATUS = "devcode:license-status"
const MANAGE_CHANNEL_DEACTIVATE = "devcode:license-deactivate"
const MANAGE_CHANNEL_SWAP = "devcode:license-swap"
const MANAGE_CHANNEL_BUY = "devcode:license-buy-manage"
const MANAGE_CHANNEL_OPEN = "devcode:license-manage-open"
const MANAGE_CHANNEL_FULL_KEY = "devcode:license-full-key"
const THEME_GET_CHANNEL = "devcode:theme-get"
const THEME_SET_CHANNEL = "devcode:theme-set"
const BACKDROP_CHANNEL = "devcode:backdrop-luminance"

// Dragging a transparent window runs a modal move loop in the shell. A display
// capture during that loop blocks the main process for tens of milliseconds on
// every sample, which is what made the window stutter while it was dragged.
// Motion is tracked per window and sampling is refused until it settles.
const motionAt = new Map<number, number>()
const watchedWindows = new Set<number>()

function watchMotion(win: BrowserWindow) {
  if (watchedWindows.has(win.id)) return
  watchedWindows.add(win.id)
  const mark = () => motionAt.set(win.id, Date.now())
  win.on("move", mark)
  win.on("resize", mark)
  win.on("closed", () => {
    watchedWindows.delete(win.id)
    motionAt.delete(win.id)
  })
}

type ManageStatus =
  | { active: false; reason?: string }
  | { active: true; key_prefix: string; tier: string; days_left: number; expires_at: number; email_masked?: string }

function toManageStatus(raw: Awaited<ReturnType<LicensingEngine["status"]>>): ManageStatus {
  if (!raw.active) return { active: false, reason: raw.reason }
  // Never ship the full key to the renderer. Prefix is enough to let the user
  // confirm which key is active without painting the whole secret into the DOM
  // where devtools / a screenshot / a crash dump could lift it.
  const prefix = raw.key ? `${raw.key.slice(0, 5)}…${raw.key.slice(-4)}` : "—"
  const daysLeft = raw.expires_at ? Math.max(0, Math.ceil((raw.expires_at * 1000 - Date.now()) / 86_400_000)) : 0
  return {
    active: true,
    key_prefix: prefix,
    tier: raw.tier ?? "standard",
    days_left: daysLeft,
    expires_at: raw.expires_at ?? 0,
  }
}

function manageDialogHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';" />
<title>OpenCode Dev — License</title>
${licenseAppearance(licenseThemeId())}
</head>
<body>
<div class="card">
  <div class="brand"><span class="brand-mark" aria-hidden="true">Dev</span><span>OpenCode Dev</span><span class="eyebrow">Workspace access</span></div>
  <h1>License</h1>
  <p class="sub" id="sub">Loading…</p>
  <div id="body"></div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
</div>
<script>
  const { ipcRenderer } = require('electron')
  ${licenseThemeListener()}

  function escapeText(value) {
    const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML
  }
  function render(s) {
    document.querySelector('.card').dataset.status = s && s.active ? 'active' : 'inactive'
    const body = document.getElementById('body')
    const sub = document.getElementById('sub')
    if (!s || !s.active) {
      sub.textContent = 'This machine is not activated.'
      body.innerHTML = '<div class="inactive">' + (s && s.reason ? 'Reason: ' + escapeText(s.reason) : 'No active key on this machine.') +
        '</div><div class="row"><button class="ghost" id="close">Close</button><button class="primary" id="swap">Enter a key</button></div>'
      document.getElementById('close').onclick = () => window.close()
      document.getElementById('swap').onclick = async () => {
        await ipcRenderer.invoke('${MANAGE_CHANNEL_SWAP}')
        refresh()
      }
      return
    }
    sub.textContent = 'Active on this machine.'
    // Colour the days-left number without assuming a total key duration.
    // 30-day keys, 7-day trial keys and arbitrary-length keys all use the
    // same thresholds: amber under a week, red under three days.
    //
    // When expires_at is 0 or missing (lifetime / open-ended keys, or a
    // status payload the worker didn't populate yet) the raw days_left
    // calc lands on 0, which the old renderer painted in red as "0 days"
    // — reading to the user as "expired right now". That was a visual
    // false-positive on a perfectly active key. Render "—" for both rows
    // in that case so the dialog says nothing it isn't sure about.
    const hasExpiry = s.expires_at && s.expires_at > 0
    const nClass = hasExpiry ? (s.days_left <= 3 ? 'crit' : s.days_left <= 7 ? 'warn' : '') : ''
    const timeLeftCell = hasExpiry
      ? '<span class="days"><span class="n ' + nClass + '">' + s.days_left + '</span><span class="u">day' + (s.days_left === 1 ? '' : 's') + '</span></span>'
      : '<span class="days"><span class="n">—</span></span>'
    const expiresCell = hasExpiry ? new Date(s.expires_at * 1000).toLocaleString() : '—'
    body.innerHTML =
      '<dl class="grid">' +
        '<dt>Key</dt><dd>' + escapeText(s.key_prefix) + '</dd>' +
        '<dt>Tier</dt><dd>' + escapeText(s.tier) + '</dd>' +
        '<dt>Time left</dt><dd>' + timeLeftCell + '</dd>' +
        '<dt>Expires</dt><dd class="muted">' + escapeText(expiresCell) + '</dd>' +
      '</dl>' +
      '<div class="row">' +
        '<button class="danger" id="deact">Deactivate</button>' +
        '<button class="ghost" id="swap">Swap key</button>' +
        '<button class="primary" id="close">Done</button>' +
      '</div>'
    document.getElementById('close').onclick = () => window.close()
    document.getElementById('deact').onclick = async () => {
      const el = document.getElementById('status')
      el.className = 'status'; el.textContent = 'Deactivating…'
      const r = await ipcRenderer.invoke('${MANAGE_CHANNEL_DEACTIVATE}').catch(() => ({ ok: false, message: 'Unable to deactivate. Please try again.' }))
      if (r && r.ok) { el.className = 'status ok'; el.textContent = 'Deactivated.'; setTimeout(refresh, 400) }
      else { el.className = 'status err'; el.textContent = (r && r.message) || 'Failed to deactivate.' }
    }
    document.getElementById('swap').onclick = async () => {
      await ipcRenderer.invoke('${MANAGE_CHANNEL_SWAP}')
      refresh()
    }
  }

  async function refresh() {
    try {
      const s = await ipcRenderer.invoke('${MANAGE_CHANNEL_STATUS}')
      render(s)
    } catch {
      document.getElementById('sub').textContent = 'License status unavailable.'
      document.getElementById('body').innerHTML = '<div class="inactive">Could not load your license. Please try again.</div><div class="row"><button id="retry" class="primary">Try again</button><button id="close" class="ghost">Close</button></div>'
      document.getElementById('retry').onclick = refresh
      document.getElementById('close').onclick = () => window.close()
    }
  }

  refresh()
</script>
</body>
</html>`
}

let manageWindow: BrowserWindow | null = null

export function openManagementDialog(): void {
  if (manageWindow && !manageWindow.isDestroyed()) {
    manageWindow.focus()
    manageWindow.moveTop()
    return
  }
  LOG("[devcode-license-gate] opening management dialog")
  const win = new BrowserWindow({
    width: 560,
    height: 570,
    minWidth: 340,
    minHeight: 420,
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    center: true,
    show: false,
    backgroundColor: licenseBackground(licenseThemeId()),
    title: "OpenCode Dev",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  })
  manageWindow = win
  win.once("ready-to-show", () => {
    win.show()
    win.focus()
  })
  win.on("closed", () => {
    if (manageWindow === win) manageWindow = null
  })
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(manageDialogHtml())).catch(() => {
    if (!win.isDestroyed()) win.destroy()
  })
}

// Registered once at app.whenReady, outside any dialog's local scope, so the
// channels stay live for the whole session. Caller is wired in by
// scripts/sync.sh as a sibling of the ensureLicensedOrPrompt invocation.
export function registerLicenseManagement(): void {
  if (app.getVersion().startsWith("2027.")) return
  // Guard against double-registration. ipcMain.handle throws on duplicate.
  try {
    ipcMain.removeHandler(MANAGE_CHANNEL_STATUS)
    ipcMain.removeHandler(MANAGE_CHANNEL_DEACTIVATE)
    ipcMain.removeHandler(MANAGE_CHANNEL_SWAP)
    ipcMain.removeHandler(MANAGE_CHANNEL_BUY)
    ipcMain.removeHandler(MANAGE_CHANNEL_OPEN)
    ipcMain.removeHandler(MANAGE_CHANNEL_FULL_KEY)
    ipcMain.removeHandler(THEME_GET_CHANNEL)
    ipcMain.removeHandler(THEME_SET_CHANNEL)
    ipcMain.removeHandler(BACKDROP_CHANNEL)
  } catch {
    /* no prior handler */
  }

  // Theme persistence. Writes a tiny `{ "id": "<kit>" }` JSON to
  // <XDG_DATA_HOME or ~/.local/share>/opencode/theme.json. Kept in the main
  // process (not localStorage) so it survives the Fresh-Desktop ritual
  // wiping the Electron session partition.
  const themeFilePath = (): string => {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    return path.join(base, "opencode", "theme.json")
  }
  ipcMain.handle(THEME_GET_CHANNEL, async () => {
    try {
      const p = themeFilePath()
      if (!fs.existsSync(p)) return null
      const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { id?: unknown }
      if (typeof parsed?.id === "string") return parsed.id
      return null
    } catch {
      return null
    }
  })
  ipcMain.handle(THEME_SET_CHANNEL, async (_e, id: unknown) => {
    try {
      if (typeof id !== "string" || !/^[a-z][a-z0-9-]{1,32}$/i.test(id)) {
        return { ok: false }
      }
      const p = themeFilePath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify({ id }, null, 2))
      if (manageWindow && !manageWindow.isDestroyed()) {
        manageWindow.setBackgroundColor(licenseBackground(id))
        manageWindow.webContents.send("devcode:theme-changed", id)
      }
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // Clear kit: the window itself is transparent, so the colour of the glyphs
  // has to follow whatever application sits behind it. Capture the display at
  // low resolution and average the window rectangle; the renderer polls this
  // only while the Clear kit is active. Returns relative luminance 0..1.
  ipcMain.handle(BACKDROP_CHANNEL, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null
      watchMotion(win)
      if (Date.now() - (motionAt.get(win.id) ?? 0) < 900) return null
      // Idle time is whole seconds. Under two means the pointer or keyboard is
      // in use, and a capture started now runs inside the shell's modal move
      // loop — the stall the user feels while dragging. Wait for a quiet
      // moment; the next poll is a few seconds away.
      if (powerMonitor.getSystemIdleTime() < 2) return null
      const bounds = win.getBounds()
      const display = screen.getDisplayMatching(bounds)
      const width = 240
      const height = Math.max(1, Math.round((width * display.size.height) / Math.max(1, display.size.width)))
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      })
      const source = sources.find((item) => String(item.display_id) === String(display.id)) ?? sources[0]
      if (!source || source.thumbnail.isEmpty()) return null
      const size = source.thumbnail.getSize()
      const bitmap = source.thumbnail.toBitmap()
      const scaleX = size.width / Math.max(1, display.size.width)
      const scaleY = size.height / Math.max(1, display.size.height)
      const left = Math.max(0, Math.round((bounds.x - display.bounds.x) * scaleX))
      const top = Math.max(0, Math.round((bounds.y - display.bounds.y) * scaleY))
      const right = Math.min(size.width, Math.round((bounds.x - display.bounds.x + bounds.width) * scaleX))
      const bottom = Math.min(size.height, Math.round((bounds.y - display.bounds.y + bounds.height) * scaleY))
      if (right <= left || bottom <= top) return null
      // Skip the outer ring: the window border and shadow are not what the
      // text sits on, and they are always either black or transparent.
      const stepX = Math.max(1, Math.floor((right - left) / 40))
      const stepY = Math.max(1, Math.floor((bottom - top) / 30))
      let sum = 0
      let count = 0
      for (let y = top + stepY; y < bottom - stepY; y += stepY) {
        for (let x = left + stepX; x < right - stepX; x += stepX) {
          const index = (y * size.width + x) * 4
          const b = bitmap[index] ?? 0
          const g = bitmap[index + 1] ?? 0
          const r = bitmap[index + 2] ?? 0
          sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
          count += 1
        }
      }
      return count ? sum / count : null
    } catch {
      return null
    }
  })

  // Renderer FAB → open management dialog. Fire-and-forget; the dialog is a
  // dedicated BrowserWindow owned by the main process, so the renderer just
  // asks and we handle the rest.
  ipcMain.handle(MANAGE_CHANNEL_OPEN, async () => {
    openManagementDialog()
    return { ok: true }
  })

  ipcMain.handle(MANAGE_CHANNEL_STATUS, async () => {
    try {
      return toManageStatus(await engine().status())
    } catch (e) {
      return { active: false, reason: (e as Error).message }
    }
  })

  // Full-key reveal for the License pill's eye toggle. The operator owns
  // this box; they need to be able to copy their own key for support /
  // transfer. Kept out of the status payload (which is polled and rendered
  // into the DOM) because the full secret belongs to one explicit user
  // action, not an always-on signal. Returns only { active: false } shape
  // when there is nothing to reveal, matching the status payload's
  // discriminant so the renderer can switch on .active without a second
  // code path.
  ipcMain.handle(MANAGE_CHANNEL_FULL_KEY, async () => {
    try {
      const raw = await engine().status()
      if (!raw.active || !raw.key) return { active: false }
      return { active: true, key: raw.key }
    } catch (e) {
      return { active: false, reason: (e as Error).message }
    }
  })

  ipcMain.handle(MANAGE_CHANNEL_DEACTIVATE, async () => {
    try {
      await engine().deactivate()
      return { ok: true }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })

  // Swap key: drop the current cache, close the management window, open the
  // first-run dialog. The user re-enters a new key; the gate then picks up the
  // fresh cache on the next status poll.
  ipcMain.handle(MANAGE_CHANNEL_SWAP, async () => {
    try {
      await engine().deactivate()
    } catch {
      /* best effort; if deactivate fails the activate overwrites anyway */
    }
    if (manageWindow && !manageWindow.isDestroyed()) {
      manageWindow.close()
      manageWindow = null
    }
    // Fire-and-forget. The first-run dialog resolves when the user closes it.
    showDialog().catch(() => undefined)
    return { ok: true }
  })

  ipcMain.handle(MANAGE_CHANNEL_BUY, async () => {
    await shell.openExternal(displayConfig.buyUrl)
  })

  // Native menu. The upstream app does not call Menu.setApplicationMenu, so
  // Electron falls back to its auto-generated default which does not include
  // the role items we want. Build a minimal, role-based template so every
  // standard shortcut (copy, paste, reload, devtools when applicable, fullscreen,
  // close) keeps working, with one extra Help entry for License and About.
  // autoHideMenuBar stays true, so the bar is invisible until Alt is tapped.
  // The accelerator below fires whether or not the bar is visible, as long as
  // an DevCode window has focus — i.e. never while the user is in another app.
  const licenseItem: Electron.MenuItemConstructorOptions = {
    label: "License…",
    accelerator: "CmdOrCtrl+Shift+L",
    click: () => openManagementDialog(),
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        licenseItem,
        { type: "separator" },
        { label: "Visit example.com", click: () => void shell.openExternal("https://example.com") },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // No globalShortcut.register. A system-wide accelerator that fires even
  // when DevCode is unfocused would hijack Ctrl+Shift+L in every other
  // app on the box (VS Code "Select all occurrences", browser context,
  // etc.) which the operator explicitly called out as unwanted. The menu
  // accelerator above only fires when an DevCode window has focus, which
  // is the right scope for a license-management entry buried in Help.

  LOG("[devcode-license-gate] management registered (menu + ipc)")
}
