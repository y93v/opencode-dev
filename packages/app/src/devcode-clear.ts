// Clear kit settings: glass opacity, blur radius and wallpaper.
// The wallpaper image itself lives in IndexedDB (localStorage is far too
// small for a 20 MB photo); the setting only records whether one is used.
export type ClearSettings = {
  alpha: number
  blur: number
  accent: string
  autoAccent: boolean
  wallpaper: "none" | "custom"
}

const KEY = "devcode:clear"
const DB_NAME = "devcode-clear"
const STORE = "wallpaper"
const RECORD = "image"
const MAX_BYTES = 20 * 1024 * 1024
const TYPES = ["image/png", "image/jpeg", "image/webp"]
export const CLEAR_DEFAULTS: ClearSettings = {
  alpha: 0,
  blur: 14,
  accent: "#f4f4f5",
  autoAccent: true,
  wallpaper: "none",
}
const HEX = /^#[0-9a-f]{6}$/i

function lighten(hex: string, amount: number) {
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(parseInt(hex.slice(offset, offset + 2), 16) * (1 - amount) + 255 * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

let objectUrl: string | undefined

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

export function readClear(): ClearSettings {
  if (typeof window === "undefined") return CLEAR_DEFAULTS
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<ClearSettings> | null
    if (!raw) return CLEAR_DEFAULTS
    return {
      alpha: clamp(Number(raw.alpha), 0, 1),
      blur: clamp(Number(raw.blur), 0, 100),
      accent: typeof raw.accent === "string" && HEX.test(raw.accent) ? raw.accent : CLEAR_DEFAULTS.accent,
      autoAccent: raw.autoAccent !== false,
      wallpaper: raw.wallpaper === "custom" ? "custom" : "none",
    }
  } catch {
    return CLEAR_DEFAULTS
  }
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }),
  )
}

export async function saveWallpaper(file: File): Promise<string | undefined> {
  if (!TYPES.includes(file.type)) return "Choose a PNG, JPG or WebP image."
  if (file.size > MAX_BYTES) return "Image is larger than 20 MB."
  try {
    await transaction("readwrite", (store) => store.put(file, RECORD))
    // Drop the cached object URL; a replacement must not keep painting the
    // previous image until the next launch.
    flush()
    return undefined
  } catch (error) {
    return `Could not save the image: ${String(error)}`
  }
}

export async function clearWallpaper() {
  try {
    await transaction("readwrite", (store) => store.delete(RECORD))
  } catch {
    /* Nothing stored. */
  }
  flush()
  void updateContrast()
}

export async function hasWallpaper() {
  try {
    return (await transaction("readonly", (store) => store.get(RECORD))) != null
  } catch {
    return false
  }
}

function flush() {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = undefined
}

async function wallpaperUrl() {
  flush()
  const file = await transaction<File | undefined>("readonly", (store) => store.get(RECORD))
  if (!(file instanceof Blob)) return undefined
  objectUrl = URL.createObjectURL(file)
  return objectUrl
}

// Reads the stored wallpaper's most colourful pixel and lifts it toward white
// so the accent keeps contrast on the dark glass and never matches the
// background exactly.
export async function accentFromWallpaper(): Promise<string | undefined> {
  try {
    const file = await transaction<File | undefined>("readonly", (store) => store.get(RECORD))
    if (!(file instanceof Blob)) return undefined
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement("canvas")
    canvas.width = 32
    canvas.height = 32
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0, 32, 32)
    const { data } = context.getImageData(0, 0, 32, 32)
    let best: { score: number; r: number; g: number; b: number } | undefined
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index]!
      const g = data[index + 1]!
      const b = data[index + 2]!
      const a = data[index + 3]!
      if (a < 160) continue
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      const score = ((max - min) / 255) * (0.3 + lum)
      if (!best || score > best.score) best = { score, r, g, b }
    }
    if (!best) return undefined
    const hex = `#${[best.r, best.g, best.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`
    const lum = (0.299 * best.r + 0.587 * best.g + 0.114 * best.b) / 255
    return lighten(hex, Math.min(0.55, Math.max(0, (0.74 - lum) / Math.max(0.01, 1 - lum))))
  } catch {
    return undefined
  }
}

export async function applyWallpaper(mode: ClearSettings["wallpaper"], force = false) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  if (mode !== "custom") {
    root.style.removeProperty("--wallpaper")
    root.dataset.wallpaper = "none"
    void updateContrast()
    return
  }
  if (objectUrl && !force) {
    root.style.setProperty("--wallpaper", `url("${objectUrl}")`)
    root.removeAttribute("data-wallpaper")
    void updateContrast()
    return
  }
  const url = await wallpaperUrl()
  if (!url) {
    root.style.removeProperty("--wallpaper")
    root.dataset.wallpaper = "none"
    void updateContrast()
    return
  }
  root.style.setProperty("--wallpaper", `url("${url}")`)
  root.removeAttribute("data-wallpaper")
  void updateContrast()
}

// --- Adaptive text contrast -------------------------------------------------
// The window is transparent, so the glyph colour has to follow whatever sits
// behind it. With a custom wallpaper the image is the backdrop and is sampled
// locally; otherwise the main process captures the display at low resolution
// and averages the window rectangle.
//
// Switching needs two consecutive samples outside a band. A single threshold
// flipped the whole UI between dark and light text whenever the sampled
// luminance drifted across it, which read as flicker.
const BRIGHT_ON = 0.68
const BRIGHT_OFF = 0.52
let contrastTimer: number | undefined
let contrastBusy = false
let contrastLevel: "bright" | "dark" = "dark"
let brightStreak = 0
let darkStreak = 0

type ContrastBridge = { backdropLuminance?: () => Promise<number | null> }

function contrastBridge(): ContrastBridge | undefined {
  return (window as unknown as { electron?: { devcode?: ContrastBridge } }).electron?.devcode
}

function setContrast(level: "bright" | "dark") {
  const root = document.documentElement
  if (root.dataset.ocContrast === level) return
  root.dataset.ocContrast = level
}

function considerContrast(luminance: number) {
  const current = contrastLevel === "bright"
  const want = current ? luminance > BRIGHT_OFF : luminance > BRIGHT_ON
  if (want === current) {
    brightStreak = 0
    darkStreak = 0
    return
  }
  if (want) brightStreak += 1
  else darkStreak += 1
  if (brightStreak >= 2) {
    contrastLevel = "bright"
    brightStreak = 0
    darkStreak = 0
    setContrast("bright")
    return
  }
  if (darkStreak >= 2) {
    contrastLevel = "dark"
    brightStreak = 0
    darkStreak = 0
    setContrast("dark")
  }
}

async function wallpaperLuminance(): Promise<number | undefined> {
  const file = await transaction<File | undefined>("readonly", (store) => store.get(STORE))
  if (!(file instanceof Blob)) return undefined
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement("canvas")
  canvas.width = 24
  canvas.height = 24
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    return undefined
  }
  context.drawImage(bitmap, 0, 0, 24, 24)
  bitmap.close()
  const { data } = context.getImageData(0, 0, 24, 24)
  let sum = 0
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! < 128) continue
    sum += (0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!) / 255
    count += 1
  }
  return count ? sum / count : undefined
}

async function updateContrast() {
  if (typeof document === "undefined" || contrastBusy) return
  if (document.visibilityState !== "visible") return
  contrastBusy = true
  try {
    const settings = readClear()
    const luminance =
      settings.wallpaper === "custom" ? await wallpaperLuminance() : await contrastBridge()?.backdropLuminance?.()
    if (typeof luminance === "number" && Number.isFinite(luminance)) {
      considerContrast(luminance)
    }
  } catch {
    /* Sampling is best effort; the halo fallback covers a failed sample. */
  } finally {
    contrastBusy = false
  }
}

function startContrast() {
  if (typeof window === "undefined" || contrastTimer !== undefined) return
  contrastLevel = document.documentElement.dataset.ocContrast === "bright" ? "bright" : "dark"
  brightStreak = 0
  darkStreak = 0
  void updateContrast()
  contrastTimer = window.setInterval(() => void updateContrast(), 4000)
}

function stopContrast() {
  if (typeof window === "undefined") return
  if (contrastTimer !== undefined) window.clearInterval(contrastTimer)
  contrastTimer = undefined
  contrastLevel = "dark"
  brightStreak = 0
  darkStreak = 0
  document.documentElement.removeAttribute("data-oc-contrast")
}

export function applyClear(settings: ClearSettings = readClear()) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.style.setProperty("--glass-alpha", String(settings.alpha))
  root.style.setProperty("--glass-blur", `${settings.blur}px`)
  root.style.setProperty("--kit-accent", settings.accent)
  root.style.setProperty("--kit-accent-hover", lighten(settings.accent, 0.25))
  root.style.setProperty("--v2-accent", settings.accent)
  if (settings.autoAccent && settings.wallpaper === "custom") {
    void accentFromWallpaper().then((accent) => {
      if (!accent) return
      root.style.setProperty("--kit-accent", accent)
      root.style.setProperty("--kit-accent-hover", lighten(accent, 0.25))
      root.style.setProperty("--v2-accent", accent)
    })
  }
  void applyWallpaper(settings.wallpaper)
  startContrast()
}

export function clearClear() {
  if (typeof document === "undefined") return
  const root = document.documentElement
  stopContrast()
  root.style.removeProperty("--glass-alpha")
  root.style.removeProperty("--glass-blur")
  root.style.removeProperty("--kit-accent")
  root.style.removeProperty("--kit-accent-hover")
  root.style.removeProperty("--v2-accent")
  root.style.removeProperty("--wallpaper")
  root.removeAttribute("data-wallpaper")
  flush()
}

export function saveClear(settings: ClearSettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* Storage is optional; the inline properties still apply this session. */
  }
  // The glass variables belong to the Clear kit. Saving a wallpaper while a
  // different theme is active must not overwrite that theme's accent or glass
  // tokens; the theme provider applies the saved values when Clear is chosen.
  if (typeof document === "undefined" || document.documentElement.dataset.devTheme === "clear") {
    applyClear(settings)
  }
}
