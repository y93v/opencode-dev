export * as DevcodeAbliterated from "./devcode-abliterated.js"

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode/util/global"
import bundledContent from "./plugin/abliterated-AGENTS.md" with { type: "text" }

// ── Per-model JB files (each tuned for a specific model's behaviour) ──────────
import jbDeepSeek from "./plugin/jb-models/DEEPSEEK-V41-MAX.md" with { type: "text" }
import jbGlm from "./plugin/jb-models/GLM-53-FLASH-MAX.md" with { type: "text" }
import jbBigPickle from "./plugin/jb-models/BIG-PICKLE.md" with { type: "text" }
import jbBeam from "./plugin/jb-models/BEAM-FREE-MAX.md" with { type: "text" }
import jbHy4 from "./plugin/jb-models/HY4-FLASH-HIGH.md" with { type: "text" }
import jbMimo from "./plugin/jb-models/MIMO-V26-FLASH.md" with { type: "text" }

// Map: lowercased model-id substring → JB content.
// The first matching entry wins, so put more-specific keys first.
const MODEL_JB_MAP: Array<[string, string]> = [
  ["deepseek",   jbDeepSeek],
  ["glm",        jbGlm],
  ["big-pickle", jbBigPickle],
  ["pickle",     jbBigPickle],
  ["beam",       jbBeam],
  ["hy4",        jbHy4],
  ["mimo",       jbMimo],
]

// One global switch for the abliterated project instructions. Stored in the
// opencode data dir so the CLI sidecar and the desktop read the same value.
// Missing file means off.
const FILE = path.join(Global.Path.data, "devcode-abliterated.json")
// Stay below the sidecar's default request-body cap after JSON escaping.
const MAX_CONTENT = 750_000
const MAX_PRESETS = 20
const MAX_NAME = 80

export const DefaultContent = bundledContent

export function filePath() {
  return FILE
}

export type Preset = { id: string; name: string; content: string }

type State = { enabled?: unknown; content?: unknown; presets?: unknown }

function read(): State {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8")) as unknown
    return value && typeof value === "object" ? (value as State) : {}
  } catch {
    return {}
  }
}

function write(state: State) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const temp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state), "utf8")
  fs.renameSync(temp, FILE)
}

export function enabled() {
  return read().enabled === true
}

export function custom() {
  // An explicit empty string is a saved custom prompt: Auto JB stays on and
  // injects nothing. Only a missing key means "use the bundled default".
  return typeof read().content === "string"
}

/** The active instruction set: the user's content when present, else bundled. */
export function content() {
  const value = read().content
  return typeof value === "string" ? value : DefaultContent
}

/**
 * Returns the best-matching JB content for the given model ID.
 * - If the user has set a custom content override, that always wins.
 * - Otherwise, picks the per-model tuned file based on modelId keywords.
 * - Falls back to the bundled v10 compact set for unknown models.
 */
export function contentForModel(modelId: string): string {
  // User override always takes priority
  const state = read()
  if (typeof state.content === "string") return state.content

  // Per-model tuned JB
  const lower = modelId.toLowerCase()
  for (const [key, jbContent] of MODEL_JB_MAP) {
    if (lower.includes(key)) return jbContent
  }

  // Default: bundled v10 (the strongest general-purpose set)
  return DefaultContent
}

export function presets(): Preset[] {
  const value = read().presets
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const preset = item as Partial<Preset>
    if (typeof preset.id !== "string" || typeof preset.name !== "string" || typeof preset.content !== "string") return []
    return [{ id: preset.id, name: preset.name, content: preset.content }]
  })
}

/** Name of the preset matching the active content, or a sentinel. */
export function activePreset() {
  const current = content()
  if (current === DefaultContent) return "default"
  const match = presets().find((preset) => preset.content === current)
  return match ? match.id : "custom"
}

export function setEnabled(value: boolean) {
  write({ ...read(), enabled: value })
}

export function setContent(value: string) {
  if (value.length > MAX_CONTENT) throw new Error(`auto jb content exceeds ${MAX_CONTENT} characters`)
  const current = read()
  // Persist the empty string. It means "Auto JB on, inject nothing"; a missing
  // `content` key is what restores the bundled set.
  write({ ...current, content: value })
}

export function resetContent() {
  const current = read()
  delete current.content
  write(current)
}

export function savePreset(name: string, value: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("preset name is required")
  if (trimmed.length > MAX_NAME) throw new Error(`preset name exceeds ${MAX_NAME} characters`)
  if (value.length > MAX_CONTENT) throw new Error(`preset content exceeds ${MAX_CONTENT} characters`)
  const current = presets()
  const existing = current.find((preset) => preset.name.toLowerCase() === trimmed.toLowerCase())
  if (!existing && current.length >= MAX_PRESETS) throw new Error(`preset limit is ${MAX_PRESETS}`)
  const preset: Preset = existing
    ? { ...existing, name: trimmed, content: value }
    : { id: randomUUID(), name: trimmed, content: value }
  write({
    ...read(),
    content: value,
    presets: existing ? current.map((item) => (item.id === existing.id ? preset : item)) : [...current, preset],
  })
  return preset
}

export function deletePreset(id: string) {
  const current = presets()
  const next = current.filter((preset) => preset.id !== id)
  if (next.length === current.length) return false
  write({ ...read(), presets: next })
  return true
}

export function isDefault(value: string) {
  return value === DefaultContent
}

export const MaxContentLength = MAX_CONTENT
export const MaxPresets = MAX_PRESETS
