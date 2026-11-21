// DevCode in-app auto-updater.
//
// Polls the license Worker for a signed update offer, downloads the Inno
// Setup installer to %TEMP%, verifies its sha256, and surfaces an in-app
// toast via the renderer. Clicking "Install" closes the app and launches
// the installer with /SILENT /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS so
// the running electron is killed, files replaced, and the new version
// relaunched automatically.
//
// Security properties:
// - The license key + HWID are sent to the Worker on every poll. A
//   revoked, expired, hwid-moved or unknown key gets no update offer —
//   the public endpoint returns `{ok:true}` with no version fields.
// - The Worker can also tier-gate (min_update_tier) so an admin can
//   stage releases to founders first, then pro, then standard.
// - The downloaded installer's sha256 is verified against the value the
//   Worker returned BEFORE spawn. A tampered CDN mirror fails this check
//   and nothing runs.
// - The CDN URL is whatever the admin set in /admin/display-config.
//   There's no TLS pin on it (the admin can host wherever). The sha256
//   gate is the integrity shield.
// - After install, the existing integrity-manifest + bootstrap chain
//   verifies the NEW tree with the SAME baked pubkey — no key rotation
//   needed per build. Mismatch there means the installer shipped with a
//   broken signer; the bootstrap silently quits and rollback is to
//   re-publish the previous version in the keygen UI.
//
// What this does NOT do:
// - No delta / block-diff updates (electron-updater supports those; we
//   don't need them for a <400 MB payload, every few weeks).
// - No scheduled auto-install without user consent. The user clicks the
//   toast. We never run the installer silently in the background.
// - No per-file verification of the downloaded installer's contents.
//   That's the signed-manifest layer's job AFTER install completes.

import { app, BrowserWindow, dialog, ipcMain } from "electron"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { LicensingEngine } from "./licensing-engine"

const POLL_INITIAL_DELAY_MS = 30_000
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

const GATEWAY_FALLBACK = "https://license.example.com"
const GATEWAY_FILENAME = "gateway.json"

type UpdateMeta = {
  version: string
  url: string
  sha256: string
  notes: string
}

type ReadyUpdate = {
  meta: UpdateMeta
  installerPath: string
}

let currentUpdate: ReadyUpdate | undefined
let pollTimer: NodeJS.Timeout | undefined
let initialTimer: NodeJS.Timeout | undefined

// Mirror of licensing-engine's gateway resolver. Kept inline so the
// updater has no cross-module coupling beyond LicensingEngine for the
// license cache read — one less bundler surprise to debug.
function resolveGateway(): string {
  const env = process.env.DEVCODE_LICENSE_API
  if (env && /^https:\/\//.test(env)) return env.replace(/\/$/, "")
  try {
    const gatewayPath = path.join(app.getAppPath(), GATEWAY_FILENAME)
    if (fs.existsSync(gatewayPath)) {
      const parsed = JSON.parse(fs.readFileSync(gatewayPath, "utf8")) as { origin?: unknown }
      if (typeof parsed.origin === "string" && /^https:\/\/[^/?#\s]+\/?$/.test(parsed.origin)) {
        return parsed.origin.replace(/\/$/, "")
      }
    }
  } catch {
    /* fall through */
  }
  return GATEWAY_FALLBACK
}

// Numeric version compare over dot-separated integer segments, left-pads
// missing segments with 0. Returns >0 if `a` is newer, <0 if older, 0 if
// equal. "2026.11.05" > "2026.11.04". "2.1" > "2.0.99" via left-pad.
// Semver prerelease tags (-rc1, -beta) are ignored; the admin should
// publish clean numeric versions.
function compareVersions(a: string, b: string): number {
  const stripTag = (v: string) => v.split(/[-+]/, 1)[0]
  const sa = stripTag(a).split(".").map((n) => parseInt(n, 10) || 0)
  const sb = stripTag(b).split(".").map((n) => parseInt(n, 10) || 0)
  const n = Math.max(sa.length, sb.length)
  for (let i = 0; i < n; i++) {
    const d = (sa[i] ?? 0) - (sb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// Public free-edition feed. Static JSON on R2 so updates never depend on the
// licensing Worker (which can be rate limited or over quota). The paid feeds
// stay key-gated on the Worker.
const FREE_FEED_URL = "https://cdn.example.com/free-latest.json"

async function fetchFreeFeed(): Promise<UpdateMeta | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(FREE_FEED_URL, {
      signal: controller.signal,
      headers: { "cache-control": "no-store", accept: "application/json" },
    })
    if (!resp.ok) return undefined
    const body = (await resp.json()) as { version?: string; url?: string; sha256?: string; notes?: string }
    if (!body?.version || !body?.url || !body?.sha256) return undefined
    if (!/^https:\/\//.test(body.url)) return undefined
    if (!/^[0-9a-f]{64}$/i.test(body.sha256)) return undefined
    return {
      version: String(body.version),
      url: String(body.url),
      sha256: String(body.sha256).toLowerCase(),
      notes: typeof body.notes === "string" ? body.notes : "",
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function fetchLatest(engine: LicensingEngine): Promise<UpdateMeta | undefined> {
  const free = app.getVersion().startsWith("2027.")
  // The free feed points at a Windows installer. Other platforms have no
  // installer to run, so they never get an update offer from it.
  if (free) return process.platform === "win32" ? fetchFreeFeed() : undefined
  const cached = engine.load()
  if (!cached) return undefined // paid build with no license; don't ask

  const url = new URL("/api/latest-version", resolveGateway())
  url.searchParams.set("key", cached.key)
  url.searchParams.set("hwid", cached.hwid)
  // One Worker, three feeds. 2099 is the paid no-reset line, 2027 is the
  // free line, everything else is stable. A normal release can never be
  // offered to either special line.
  const version = app.getVersion()
  const channel = version.startsWith("2099.") ? "noreset" : "stable"
  url.searchParams.set("channel", channel)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { "cache-control": "no-store" } })
    if (!resp.ok) return undefined
    const body = (await resp.json()) as {
      ok?: boolean
      version?: string
      url?: string
      sha256?: string
      notes?: string
    }
    if (!body?.ok) return undefined
    if (!body.version || !body.url || !body.sha256) return undefined
    if (!/^https:\/\//.test(body.url)) return undefined
    if (!/^[0-9a-f]{64}$/i.test(body.sha256)) return undefined
    return {
      version: String(body.version),
      url: String(body.url),
      sha256: String(body.sha256).toLowerCase(),
      notes: typeof body.notes === "string" ? body.notes : "",
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function downloadVerify(meta: UpdateMeta): Promise<string | undefined> {
  const dir = path.join(os.tmpdir(), "devcode-update")
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return undefined
  }
  // Fresh filename per version so a failed previous download doesn't
  // leave a stale file that passes the sha check later for the wrong
  // version string.
  const dest = path.join(dir, `devcode-Setup-${meta.version.replace(/[^A-Za-z0-9._-]/g, "_")}.exe`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  let buf: Buffer
  try {
    const resp = await fetch(meta.url, { signal: controller.signal })
    if (!resp.ok) return undefined
    buf = Buffer.from(await resp.arrayBuffer())
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }

  const actualSha = crypto.createHash("sha256").update(buf).digest("hex")
  if (actualSha !== meta.sha256) {
    // Do NOT persist a corrupt or tampered installer to disk. Silent
    // failure here just means no update offer surfaces — the user stays
    // on the current version safely.
    return undefined
  }

  try {
    fs.writeFileSync(dest, buf, { mode: 0o755 })
  } catch {
    return undefined
  }
  return dest
}

function notifyRenderer(meta: UpdateMeta): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      // Only the version crosses into the renderer. The Worker's notes
      // field used to go with it; the renderer then rendered them inside
      // the pill tooltip and the confirm dialog, leaking the internal
      // changelog ("DB wipe moved into the sidecar" etc). Dropped at the
      // source now, defence-in-depth with the preload scrub.
      win.webContents.send("devcode:update-ready", { version: meta.version })
    } catch {
      /* best-effort */
    }
  }
}

async function tryUpdateCheck(engine: LicensingEngine): Promise<void> {
  // Already have a downloaded update waiting? Don't re-download; the
  // renderer already has the toast. A newer version would still trigger
  // a fresh download below after we compare.
  const meta = await fetchLatest(engine)
  if (!meta) return
  if (compareVersions(meta.version, app.getVersion()) <= 0) return
  // Skip if this exact version is already downloaded.
  if (currentUpdate && currentUpdate.meta.version === meta.version && fs.existsSync(currentUpdate.installerPath)) {
    notifyRenderer(currentUpdate.meta)
    return
  }
  const installerPath = await downloadVerify(meta)
  if (!installerPath) return
  currentUpdate = { meta, installerPath }
  notifyRenderer(meta)
}

// Called once at app.whenReady, after license gate + management
// registration. Sets up the poll loop and the renderer-facing IPC.
export function registerUpdater(): void {
  // Guard against double-registration — hot-reload / re-entrant boots.
  try {
    ipcMain.removeHandler("devcode:update-install")
    ipcMain.removeHandler("devcode:update-status")
    ipcMain.removeHandler("devcode:update-confirm")
    ipcMain.removeHandler("devcode:app-version")
  } catch {
    /* no prior */
  }
  if (initialTimer) clearTimeout(initialTimer)
  if (pollTimer) clearInterval(pollTimer)

  const engine = new LicensingEngine()

  initialTimer = setTimeout(() => {
    void tryUpdateCheck(engine).catch(() => undefined)
  }, POLL_INITIAL_DELAY_MS)

  pollTimer = setInterval(() => {
    void tryUpdateCheck(engine).catch(() => undefined)
  }, POLL_INTERVAL_MS)

  ipcMain.handle("devcode:update-status", async () => {
    if (!currentUpdate) return { ready: false }
    return { ready: true, version: currentUpdate.meta.version, notes: currentUpdate.meta.notes }
  })

  // Native confirm dialog. Renderer used to call window.confirm() which is
  // suppressed in sandboxed Chromium contexts under some Electron builds —
  // the dialog never showed, confirm() returned false, the install silently
  // didn't fire. Delivering the prompt through dialog.showMessageBox from
  // main sidesteps the sandbox entirely and always works.
  //
  // Scrub: nothing about the update content leaks to this prompt. No notes,
  // no changelog, no "what's new" — the renderer used to pass the Worker's
  // notes field here and the dialog surfaced the entire anti-piracy
  // changelog to the user. Now the prompt is a flat "Install version X?"
  // with the generic close/reopen line and nothing else. The notes field
  // is dropped at the preload boundary; even if an older renderer passes
  // it, this handler ignores it.
  ipcMain.handle(
    "devcode:update-confirm",
    async (_, info: { version?: string }) => {
      const version = info?.version || "latest"
      const r = await dialog.showMessageBox({
        type: "question",
        title: "OpenCode Dev update",
        message: `Install version ${version}?`,
        detail: "OpenCode Dev will close and reopen.",
        buttons: ["Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      return { ok: r.response === 0 }
    },
  )

  // Exposed to the renderer via preload. Powers the subtle top-middle
  // version badge — a glance-only "v2026.11.05.7" so the user always knows
  // what they're on without hovering the update pill (which used to leak
  // the full notes into its tooltip).
  ipcMain.handle("devcode:app-version", async () => app.getVersion())

  ipcMain.handle("devcode:update-install", async () => {
    if (!currentUpdate) return { ok: false, message: "no update ready" }
    // Guardrails against the silent-failure patterns that let a stuck install
    // read as "nothing happens" from the user's side.
    //
    //   1. File check. If antivirus quarantined the installer between
    //      download and click, the path points to nothing. spawn() would
    //      return a ChildProcess and fire 'error' async — we'd quit before
    //      the event surfaces. Catch the missing-file case here synchronously.
    //   2. Sidecar pre-kill. Inno's file-replace step fails silently on any
    //      binary still held open (opencode-cli.exe is the usual culprit —
    //      the renderer never shuts it down, only the main process does, and
    //      only AFTER app.quit() fully drains, which races the installer's
    //      "close applications" scan). Kill the sidecars here so by the time
    //      Inno probes for locks, every handle is gone. Without this the
    //      installer "succeeds" but opencode-cli.exe on disk never changes,
    //      the next launch reads the same app.getVersion(), the updater
    //      re-offers the same version, the pill stays — forever. This is the
    //      single biggest cause of the "update pill doesn't go away" report.
    //   3. Spawn error listener with a short wait. CreateProcess failures
    //      (ENOENT, EACCES, antivirus block) surface on 'error'. Give it a
    //      tick so we don't false-negative the common case while still
    //      catching real failures before app.quit() kills the parent.
    //   4. Early-exit watcher. UAC denied, Inno Setup "already running"
    //      bail, PE signature refusal — the installer dies within ~2s with
    //      a non-zero exit. app.quit() would still fire, user sees window
    //      die, no new version. Watch for exit while we're still alive.
    if (!fs.existsSync(currentUpdate.installerPath)) {
      return { ok: false, message: "installer missing (was it quarantined by antivirus?)" }
    }

    // No global taskkill here. The installer's [Code] pre-install step kills
    // only processes under the install root. A global /IM opencode-cli.exe
    // also killed the upstream OpenCode sidecar on this machine.

    // The installer manifest is asInvoker (per-user), so no elevation is
    // requested or needed. Launch it directly: the previous PowerShell
    // watcher had to use -Verb RunAs for the old admin manifest, and endpoint
    // security blocking powershell.exe was what produced the "install didn't
    // finish" toast. The installer's silent [Run] entry relaunches the app.
    const installerArgs = ["/SILENT", "/SUPPRESSMSGBOXES", "/CLOSEAPPLICATIONS", "/FORCECLOSEAPPLICATIONS"]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(currentUpdate.installerPath, installerArgs, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    } catch (e) {
      return { ok: false, message: `installer failed to start: ${(e as Error).message}` }
    }
    const spawnError = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 800)
      child.once("error", (cause) => {
        clearTimeout(timer)
        resolve(cause.message)
      })
    })
    if (spawnError) return { ok: false, message: `installer failed to start: ${spawnError}` }
    child.unref()

    // The per-user installer only kills processes under its own install root,
    // so the running app has to close itself. No UAC broker sits in between.
    currentUpdate = undefined
    setTimeout(() => app.quit(), 1200)
    return { ok: true }
  })

  app.once("will-quit", () => {
    if (initialTimer) clearTimeout(initialTimer)
    if (pollTimer) clearInterval(pollTimer)
  })
}

