// DevCode: locate the bundled opencode-cli[.exe] on disk.
//
// Lives in its own module because the license gate no longer needs it
// (the licensing engine moved into Electron main), but desktop-cli.ts
// and the sidecar probe still spawn the binary to run the backend. Kept
// in service/ so re-export from service/license-gate.ts stays source-
// compatible with the patched import in packages/desktop/src/main/
// index.ts (see scripts/sync.sh patches).

import { app } from "electron"
import { existsSync } from "node:fs"
import path from "node:path"

export function resolveCliBinary(): string {
  const names =
    process.platform === "win32" ? ["opencode-cli.exe", "opencode.exe"] : ["opencode-cli", "opencode"]

  const appPath = app.getAppPath()
  console.log("[devcode-cli-binary] app.getAppPath():", appPath)

  // DevCode installer layout: Inno Setup launches Electron with the
  // desktop-pkg folder as its app path, and the CLI lives inside
  // <app-path>/resources/<name>. Check this BEFORE process.resourcesPath,
  // because a non-packaged Electron (direct electron.exe) sets
  // resourcesPath to Electron's own resources dir, which does not contain
  // our CLI and makes every look-up miss.
  for (const n of names) {
    const bundled = path.join(appPath, "resources", n)
    if (existsSync(bundled)) {
      console.log("[devcode-cli-binary] CLI found (installer layout):", bundled)
      return bundled
    }
  }

  // electron-builder / asar layout — the renamed binary sits at
  // process.resourcesPath/<exe>, next to the main app.asar.
  if (process.resourcesPath) {
    for (const n of names) {
      const packaged = path.join(process.resourcesPath, n)
      if (existsSync(packaged)) {
        console.log("[devcode-cli-binary] CLI found (packaged resourcesPath):", packaged)
        return packaged
      }
    }
  }

  // Dev-tree / preview: walk up from app.getAppPath() looking for the
  // sibling cli package's dist/<arch>/bin/<name>.
  const archDir =
    process.platform === "win32"
      ? "cli-windows-x64"
      : process.platform === "darwin"
        ? process.arch === "arm64"
          ? "cli-darwin-arm64"
          : "cli-darwin-x64"
        : process.arch === "arm64"
          ? "cli-linux-arm64"
          : "cli-linux-x64"

  const bases = [
    appPath,
    path.join(appPath, ".."),
    path.join(appPath, "..", ".."),
    path.join(appPath, "..", "..", ".."),
    path.join(appPath, "..", "..", "..", ".."),
  ]
  for (const base of bases) {
    for (const n of names) {
      const c = path.resolve(base, "..", "cli", "dist", archDir, "bin", n)
      if (existsSync(c)) {
        console.log("[devcode-cli-binary] CLI found (dev-tree):", c)
        return c
      }
    }
  }
  const fallback = path.join(appPath, "resources", names[0])
  console.log("[devcode-cli-binary] all probes missed; falling through to:", fallback)
  return fallback
}
