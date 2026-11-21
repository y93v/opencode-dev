import { createSignal, ErrorBoundary, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"

// DevCode ambient background layer for animated themes. Rendered into
// <body> via a Portal so it can never affect the stacking / layout /
// clipping of vendor panels (file explorer, chat pane, dialogs). Behind
// everything with z-index: 0 + isolation: isolate — children can't
// escape this stacking context, siblings never see them.
//
// Only runs when the picked theme is in the animated set. Static themes
// render nothing (no DOM, no listeners, no cost). Switching themes is a
// Solid signal update + <Show> remount; no full reload needed.
//
// If any decoration throws during paint (rare but possible on exotic
// drivers / GPU memory pressure), the ErrorBoundary catches it and
// renders nothing — the app keeps working, the theme just loses its
// atmospheric layer. Better than a runtime that takes down the whole
// window.

function readTheme(): string {
  if (typeof document === "undefined") return ""
  return document.documentElement.getAttribute("data-theme") ?? ""
}

export function DevcodeFxAmbient() {
  const [theme, setTheme] = createSignal<string>(readTheme())

  onMount(() => {
    const html = document.documentElement
    setTheme(html.getAttribute("data-theme") ?? "")
    const obs = new MutationObserver(() => {
      const t = html.getAttribute("data-theme") ?? ""
      if (t !== theme()) setTheme(t)
    })
    obs.observe(html, { attributes: true, attributeFilter: ["data-theme"] })
    onCleanup(() => obs.disconnect())
  })

  const kit = () => theme()

  return (
    <ErrorBoundary fallback={<></>}>
      <Portal mount={document.body}>
        <div
          class="dev-ambient pointer-events-none fixed inset-0 overflow-hidden"
          style={{ "z-index": "0", isolation: "isolate" }}
          aria-hidden="true"
        >
          <Show when={kit() === "frost"}>
            <div class="dev-orb dev-orb-a" />
            <div class="dev-orb dev-orb-b" />
            <div class="dev-orb dev-orb-c" />
          </Show>
          <Show when={kit() === "porcelain"}>
            <div class="dev-blob dev-blob-a" />
            <div class="dev-blob dev-blob-b" />
            <div class="dev-blob dev-blob-c" />
          </Show>
          <Show when={kit() === "prism"}>
            <div class="dev-aura dev-aura-a" />
            <div class="dev-aura dev-aura-b" />
          </Show>
          <Show when={kit() === "vapor"}>
            <div class="dev-sky" />
          </Show>
          <Show when={kit() === "obsidian"}>
            <div class="dev-grain" />
          </Show>
        </div>
      </Portal>
    </ErrorBoundary>
  )
}
