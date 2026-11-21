import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "beta" ? "beta" : raw === "dev" ? "dev" : "prod"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<string, string> = {
  local: "OpenCode Dev",
  dev: "OpenCode Dev",
  beta: "OpenCode Dev Beta",
  prod: "OpenCode Dev",
}

const appIDs: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? (appNames[CHANNEL] ?? "OpenCode Dev") : "OpenCode Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "ai.opencode.desktop.dev"
