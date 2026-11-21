export const ANIMATED_THEMES = ["frost", "obsidian", "phosphor", "porcelain", "prism", "vapor"]
export const CURSORS = ["theme", "off", "glow", "ring", "trail"] as const
export type CursorEffect = typeof CURSORS[number]
export type EffectsPreference = { motion: boolean; cursor: CursorEffect }
// Exported so sibling components (theme-fab) can scope their own storage
// listeners to this key without duplicating the string.
export const EFFECTS_STORAGE_KEY = "devcode:effects:v2"
const KEY = EFFECTS_STORAGE_KEY
export function readEffects(): EffectsPreference {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null")
    return { motion: value?.motion !== false, cursor: CURSORS.includes(value?.cursor) ? value.cursor : "theme" }
  } catch { return { motion: true, cursor: "theme" } }
}
export function saveEffects(value: EffectsPreference) {
  try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* Session selection still works. */ }
  window.dispatchEvent(new CustomEvent("devcode:effects-changed", { detail: value }))
}

// One owned runtime. No element transforms, native-cursor replacement, or hit
// targets. Only the cursor decoration moves; trails are capped and self-remove.
export function installEffects() {
  const root = document.documentElement
  const reduced = matchMedia("(prefers-reduced-motion: reduce)")
  const fine = matchMedia("(hover: hover) and (pointer: fine)")
  // Four cores or fewer: keep the UI responsive by skipping cursor trails
  // and ambient motion. The static theme still applies.
  const lowPower = (navigator.hardwareConcurrency ?? 8) <= 4
  let preference = readEffects()
  let marker: HTMLDivElement | undefined
  let cursor: CursorEffect = "off"
  let lastTrail = 0
  const trails = new Set<HTMLElement>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const clear = () => {
    marker?.remove(); marker = undefined
    trails.forEach((node) => node.remove()); trails.clear()
    timers.forEach(clearTimeout); timers.clear()
  }
  const refresh = () => {
    clear()
    const id = root.dataset.devTheme ?? "aurora"
    const animated = ANIMATED_THEMES.includes(id)
    const active = !document.hidden && document.hasFocus()
    root.toggleAttribute(
      "data-oc-motion",
      preference.motion && animated && !reduced.matches && active && !lowPower,
    )
    root.toggleAttribute("data-oc-reduced-motion", reduced.matches)
    cursor = preference.cursor === "theme" ? (animated ? (id === "vapor" ? "trail" : id === "obsidian" ? "ring" : "glow") : "off") : preference.cursor
    if (reduced.matches || !fine.matches || !active || lowPower) cursor = "off"
  }
  const move = (event: PointerEvent) => {
    if (cursor === "off" || event.pointerType === "touch") return
    const target = event.target instanceof Element ? event.target : null
    // Native dialogs occupy the top layer. Move the decoration into that
    // layer, while preserving pointer-events:none and the system cursor.
    const host = target?.closest("dialog[open]") ?? document.body
    if (!marker) {
      marker = document.createElement("div")
      marker.className = `oc-cursor oc-cursor-${cursor}`
      marker.setAttribute("aria-hidden", "true")
    }
    if (marker.parentElement !== host) host.appendChild(marker)
    marker.style.left = `${event.clientX}px`; marker.style.top = `${event.clientY}px`
    marker.toggleAttribute("data-hot", !!target?.closest("button,a,input,select,textarea,[role=button]"))
    if (cursor !== "trail" || event.timeStamp - lastTrail < 35 || trails.size >= 12) return
    lastTrail = event.timeStamp
    const dot = document.createElement("i")
    dot.className = "oc-cursor-spark"; dot.setAttribute("aria-hidden", "true")
    dot.style.left = `${event.clientX}px`; dot.style.top = `${event.clientY}px`
    host.appendChild(dot); trails.add(dot)
    const timer = setTimeout(() => { dot.remove(); trails.delete(dot); timers.delete(timer) }, 420)
    timers.add(timer)
  }
  const changed = (event: Event) => { preference = (event as CustomEvent<EffectsPreference>).detail; refresh() }
  const stored = (event: StorageEvent) => { if (event.key === KEY) { preference = readEffects(); refresh() } }
  const leave = (event: PointerEvent) => { if (!event.relatedTarget) clear() }
  // Unfocused/minimized windows pause ambient CSS animations and cursor work.
  const pause = () => { clear(); refresh() }
  window.addEventListener("pointermove", move, { passive: true })
  window.addEventListener("pointerout", leave)
  window.addEventListener("blur", pause)
  window.addEventListener("focus", refresh)
  window.addEventListener("devcode:theme-changed", refresh)
  window.addEventListener("devcode:effects-changed", changed)
  window.addEventListener("storage", stored)
  document.addEventListener("visibilitychange", refresh)
  reduced.addEventListener("change", refresh); fine.addEventListener("change", refresh)
  refresh()
  return () => {
    clear(); root.removeAttribute("data-oc-motion"); root.removeAttribute("data-oc-reduced-motion")
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerout", leave)
    window.removeEventListener("blur", clear); window.removeEventListener("devcode:theme-changed", refresh)
    window.removeEventListener("devcode:effects-changed", changed); window.removeEventListener("storage", stored)
    document.removeEventListener("visibilitychange", refresh)
    reduced.removeEventListener("change", refresh); fine.removeEventListener("change", refresh)
  }
}
