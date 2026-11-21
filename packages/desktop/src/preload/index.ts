import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  DragCancelEvent,
  IpcTransportPort,
  WindowSnapshotChannel,
  storageSnapshotNames,
  type WindowSnapshot,
} from "../shared/ipc-transport"
import { windowBootstrapFromArguments } from "../shared/window-bootstrap"

ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]

  if (port) window.postMessage(IpcTransportPort, "*", [port])
})

ipcRenderer.on(DragCancelEvent, () => window.dispatchEvent(new Event(DragCancelEvent)))

const bootstrap = windowBootstrapFromArguments(process.argv)

// Asked before the page runs, so the stores the shell reads are hydrated on the first render.
const snapshot: Promise<WindowSnapshot> = ipcRenderer
  .invoke(WindowSnapshotChannel, storageSnapshotNames(bootstrap.id))
  .catch(() => ({ storage: {} }))

type UpdateInfoPublic = { version: string }
const updateReadyListeners = new Set<(info: UpdateInfoPublic) => void>()
ipcRenderer.on("devcode:update-ready", (_e, info: { version: string; notes?: string }) => {
  const scrubbed: UpdateInfoPublic = { version: info.version }
  updateReadyListeners.forEach((fn) => {
    try { fn(scrubbed) } catch { /* listener should not break the renderer */ }
  })
})

type LicenseStatus =
  | { active: false; reason?: string }
  | {
      active: true
      key_prefix: string
      tier: string
      days_left: number
      expires_at: number
      email_masked?: string
    }

contextBridge.exposeInMainWorld("electron", {
  windowID: bootstrap.id,
  bootstrap,
  storageSnapshot: snapshot.then((snapshot) => snapshot.storage),
  plugins: snapshot.then((snapshot) => snapshot.plugins),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  devcode: {
    openLicenseManage: () => ipcRenderer.invoke("devcode:license-manage-open"),
    licenseStatus: () => ipcRenderer.invoke("devcode:license-status") as Promise<LicenseStatus>,
    licenseFullKey: () =>
      ipcRenderer.invoke("devcode:license-full-key") as Promise<
        { active: true; key: string } | { active: false; reason?: string }
      >,
    themeGet: () => ipcRenderer.invoke("devcode:theme-get") as Promise<string | null>,
    themeSet: (id: string) => ipcRenderer.invoke("devcode:theme-set", id) as Promise<{ ok: boolean }>,
    backdropLuminance: () => ipcRenderer.invoke("devcode:backdrop-luminance") as Promise<number | null>,
    updateStatus: async (): Promise<{ ready: boolean; version?: string }> => {
      const r = await (ipcRenderer.invoke("devcode:update-status") as Promise<{ ready: boolean; version?: string; notes?: string }>)
      return r?.ready ? { ready: true, version: r.version } : { ready: false }
    },
    installUpdate: () => ipcRenderer.invoke("devcode:update-install") as Promise<{ ok: boolean; message?: string }>,
    confirmUpdate: (info: { version: string }) =>
      ipcRenderer.invoke("devcode:update-confirm", { version: info.version }) as Promise<{ ok: boolean }>,
    onUpdateReady: (fn: (info: UpdateInfoPublic) => void) => {
      updateReadyListeners.add(fn)
      return () => updateReadyListeners.delete(fn)
    },
    appVersion: () => ipcRenderer.invoke("devcode:app-version") as Promise<string>,
    openWebsite: () => ipcRenderer.invoke("devcode:open-website") as Promise<{ ok: boolean }>,
  },
})
