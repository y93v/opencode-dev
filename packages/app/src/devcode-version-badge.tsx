// Subtle top-middle version badge. A low-contrast "v2026.11.05.7" sitting
// just under the window chrome, centered. Lets the user glance at what they
// are on without hovering the update pill (which used to leak the full
// release notes in its tooltip — scrubbed now, but the badge is still a
// better affordance for "what version am I").
//
// Pure read-only. Clicking copies the version string to the clipboard so
// support conversations can start with "I'm on vX" instead of a screenshot.
// The copy affordance is the only interaction; no menu, no popover.
//
// Rendered through the same preload bridge the updater uses. Falls back to
// nothing when the bridge isn't present (TUI launcher, dev runs without the
// Electron shell) rather than painting a placeholder.

import { createSignal, onMount, Show } from "solid-js"

type Bridge = {
  appVersion?: () => Promise<string>
}

function bridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined
  const electron = (window as unknown as { electron?: { devcode?: Bridge } }).electron
  return electron?.devcode
}

export function DevcodeVersionBadge() {
  const [version, setVersion] = createSignal<string | undefined>(undefined)
  const [copied, setCopied] = createSignal(false)

  onMount(() => {
    const b = bridge()
    if (!b?.appVersion) return
    void b.appVersion().then((v) => {
      if (typeof v === "string" && v.length > 0 && v !== "0.0.0") setVersion(v)
    })
  })

  const copy = async () => {
    const v = version()
    if (!v) return
    try {
      await navigator.clipboard.writeText(`v${v}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard denied — no visible failure, badge stays idle */
    }
  }

  return (
    <Show when={version()}>
      <button
        data-slot="devcode-version-badge"
        type="button"
        onClick={copy}
        aria-label={`Current version v${version()!} — click to copy`}
        title={copied() ? "copied" : `v${version()!}`}
        class="pointer-events-auto fixed top-1.5 left-1/2 z-[9998] -translate-x-1/2 select-none rounded-full border border-transparent px-2 py-0.5 text-[10px] leading-4 font-[480] text-v2-text-text-muted/60 opacity-70 transition-[opacity,color,border-color,background-color] duration-150 ease-out hover:border-v2-border-border-muted hover:bg-v2-background-bg-layer-02/70 hover:text-v2-text-text-muted hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-focus motion-reduce:transition-none [app-region:no-drag]"
        
      >
        {copied() ? "copied" : `v${version()}`}
      </button>
    </Show>
  )
}
