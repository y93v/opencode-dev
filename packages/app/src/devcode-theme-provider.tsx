import { installEffects } from "./devcode-effects"
import { createEffect, onCleanup, onMount } from "solid-js"
import { useTheme } from "@opencode/ui/theme/context"
import type { DesktopTheme, HexColor, ThemeVariant } from "@opencode/ui/theme/types"
import { KITS, palette, themeKit, type ThemeKit } from "./devcode-themes"
import { applyTheme, readTheme } from "./devcode-theme-runtime"
import { applyClear } from "./devcode-clear"

export function nativeTheme(kit: ThemeKit): DesktopTheme {
  const p = palette(kit) as Record<string, HexColor>
  const variant: ThemeVariant = {
    palette: {
      // The grey ramp and every derived surface are generated from this seed,
      // so it has to be a real colour. `bg-base` is `transparent` for the
      // Clear kit and would turn the whole ramp black.
      neutral: p["bg-seed"] ?? p["bg-base"]!,
      ink: p["text-base"]!,
      primary: p.accent!,
      accent: p.accent!,
      interactive: p.accent!,
      success: p.success!,
      warning: p.warn!,
      error: p.danger!,
      info: p.accent!,
    },
    overrides: {
      "background-base": p["bg-base"]!,
      "background-weak": p["bg-subtle"]!,
      "background-strong": p["bg-layer-01"]!,
      "background-stronger": p["bg-layer-02"]!,
      "text-base": p["text-base"]!,
      "text-weak": p["text-muted"]!,
      "text-weaker": p["text-faint"]!,
      "text-strong": p["text-base"]!,
      "input-text-base": p["text-base"]!,
      "input-placeholder": p["text-faint"]!,
      "syntax-comment": p["text-faint"]!,
      "syntax-keyword": p.accent!,
      "syntax-string": p.success!,
      "syntax-primitive": p.warn!,
      "syntax-property": p["text-base"]!,
      "syntax-type": p.accent!,
      "syntax-constant": p.warn!,
      "icon-base": p["text-muted"]!,
      "icon-strong-base": p["text-base"]!,
      "border-base": p["border-base"]!,
      "border-weak-base": p["border-base"]!,
    },
    v2Overrides: {
      "v2-background-bg-base": p["bg-base"]!,
      "v2-background-bg-deep": p["bg-subtle"]!,
      "v2-background-bg-layer-01": p["bg-layer-01"]!,
      "v2-background-bg-layer-02": p["bg-layer-02"]!,
      "v2-background-bg-layer-03": p["bg-layer-03"]!,
      "v2-background-bg-layer-04": p["bg-layer-03"]!,
      "v2-background-bg-accent": p.accent!,
      "v2-background-bg-button-neutral": p["bg-layer-01"]!,
      "v2-text-text-contrast": p["on-accent"]!,
      "v2-icon-icon-contrast": p["on-accent"]!,
      "v2-text-text-code-accent": p.accent!,
      "v2-text-text-code-path": p.accent!,
      "v2-text-text-base": p["text-base"]!,
      "v2-text-text-muted": p["text-muted"]!,
      "v2-text-text-faint": p["text-faint"]!,
      "v2-text-text-accent": p.accent!,
      "v2-text-text-accent-hover": p["accent-hover"]!,
      "v2-icon-icon-base": p["text-base"]!,
      "v2-icon-icon-muted": p["text-muted"]!,
      "v2-icon-icon-faint": p["text-faint"]!,
      "v2-icon-icon-accent": p.accent!,
      "v2-border-border-base": p["border-base"]!,
      "v2-border-border-muted": p["border-base"]!,
      "v2-border-border-strong": p["border-strong"]!,
      "v2-border-border-focus": p.accent!,
    },
  }
  return { id: `devcode-${kit.id}`, name: `Dev · ${kit.label}`, light: variant, dark: variant }
}

export function DevcodeThemeProvider() {
  const theme = useTheme()
  const unregister = KITS.map((kit) => theme.registerTheme(nativeTheme(kit)))
  const sync = () => {
    const kit = themeKit(document.documentElement.dataset.devTheme ?? readTheme())
    if (theme.themeId() !== `devcode-${kit.id}`) theme.setTheme(`devcode-${kit.id}`)
    if (theme.colorScheme() !== kit.family) theme.setColorScheme(kit.family)
  }
  onMount(() => {
    sync()
    onCleanup(installEffects())
    window.addEventListener("devcode:theme-changed", sync)
  })
  createEffect(() => {
    const id = theme.themeId().replace(/^devcode-/, "")
    if (!KITS.some((kit) => kit.id === id)) return
    if (document.documentElement.dataset.devTheme !== id) applyTheme(id)
    // The Clear kit is the only theme that paints the wallpaper and glass
    // settings. Apply them when it becomes active so a saved image survives
    // restarts without requiring a settings visit.
    if (id === "clear") applyClear()
  })
  onCleanup(() => {
    window.removeEventListener("devcode:theme-changed", sync)
    unregister.forEach((dispose) => dispose())
  })
  return null
}
