// Runtime shield for packaged builds.
//
// Everything here is about removing inspection paths, not hiding the source:
// a packaged Electron app is JavaScript, and no amount of minification changes
// that. What we can do is refuse the tools that turn "read the bundle" into
// "run commands inside the app":
//
//   * Electron fuses (scripts/apply-fuses.ts) remove ELECTRON_RUN_AS_NODE,
//     NODE_OPTIONS injection and --inspect before any of this code runs.
//   * This module removes the Chromium remote-debugging switches, which would
//     otherwise accept a CDP client and give it the renderer's preload context.
//   * DevTools is disabled per webContents and re-closed if something opens it.
//   * The usual DevTools accelerators are swallowed.
//
// DEVCODE_ALLOW_DEVTOOLS=1 keeps everything available for a support session
// on a packaged build; development builds are untouched.
import { app, type WebContents } from "electron"
import path from "node:path"

const allowEnv = "DEVCODE_ALLOW_DEVTOOLS"

function allowed() {
  return process.env[allowEnv] === "1"
}

// This pipeline ships an unpacked app directory (`electron.exe <root>/desktop-pkg`),
// which leaves `app.isPackaged` false even though it is a released build.
// `desktop-pkg` as the app path is the reliable marker for "installed", so the
// shield and the licence gate apply to exactly the builds users run.
export function installedBuild() {
  return app.isPackaged || path.basename(app.getAppPath()) === "desktop-pkg"
}

function shielded() {
  return installedBuild() && !allowed()
}

const CDP_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  // V8 can be told to open an inspector through Chromium's JS flags.
  "js-flags",
  "inspect",
  "inspect-brk",
]

export function installShield() {
  if (!shielded()) return

  // Chromium parses argv when the process starts, so removeSwitch() cannot
  // close a DevTools listener that is already bound. Refuse to run at all when
  // a debugging endpoint was requested.
  for (const arg of process.argv) {
    if (/^--(remote-debugging-port|remote-debugging-pipe|inspect|inspect-brk|js-flags)(=|$)/.test(arg)) {
      console.error(`[shield] refusing to start with ${arg.split("=")[0]}`)
      app.exit(1)
      return
    }
  }

  // Strip anything that would open a debugging endpoint. These have to go
  // before Chromium initialises, which is why this runs at module scope in the
  // main entry rather than on ready.
  for (const name of CDP_SWITCHES) {
    if (!app.commandLine.hasSwitch(name)) continue
    const commandLine = app.commandLine as typeof app.commandLine & { removeSwitch?: (name: string) => void }
    commandLine.removeSwitch?.(name)
  }

  app.on("web-contents-created", (_event, contents) => {
    hardenContents(contents)
  })
}

function hardenContents(contents: WebContents) {
  if (!shielded()) return

  contents.on("devtools-opened", () => {
    contents.closeDevTools()
  })

  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return
    const key = input.key.toLowerCase()
    const modifier = input.control || input.meta
    const devtoolsChord =
      key === "f12" ||
      (modifier && input.shift && (key === "i" || key === "j" || key === "c")) ||
      (modifier && key === "u" && input.shift)
    if (devtoolsChord) event.preventDefault()
  })
}

// Called once ready: if a debugging switch somehow survived, refuse to run
// rather than expose an attachable endpoint for the life of the process.
export function assertNoDebugEndpoint() {
  if (!shielded()) return
  for (const arg of process.argv) {
    if (!/^--(remote-debugging-port|remote-debugging-pipe|inspect|inspect-brk)(=|$)/.test(arg)) continue
    console.error(`[shield] refusing to start with ${arg.split("=")[0]}`)
    app.exit(1)
    return
  }
  for (const name of CDP_SWITCHES) {
    if (!app.commandLine.hasSwitch(name)) continue
    console.error(`[shield] refusing to start with --${name}`)
    app.exit(1)
    return
  }
}

export function devToolsEnabled() {
  return !shielded()
}
