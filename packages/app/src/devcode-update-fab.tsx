// DevCode update-available pill. Hidden by default; shows the moment the
// main process's updater finishes downloading + verifying a new installer,
// via the `devcode:update-ready` event the preload bridge relays. Click
// prompts for confirmation, then asks main to spawn the installer and quit.
//
// Positioned alongside the Reset / website / License pills in the bottom-
// left corner. Goes to the RIGHT of License so the layout reads: Reset,
// web, License, Update. When no update is available, nothing renders — no
// hole in the layout for regular users.

import { createSignal, onCleanup, onMount, Show } from "solid-js"

// NOTE: release notes are no longer part of this bridge. The Worker still
// emits them for operator logging, but the preload layer strips them before
// they cross into the renderer so nothing about the update's content can
// appear in a tooltip, confirm dialog, or aria-label. Users see only the
// version number.
type UpdateInfo = { version: string }
type Bridge = {
  updateStatus?: () => Promise<{ ready: boolean; version?: string }>
  installUpdate?: () => Promise<{ ok: boolean; message?: string }>
  confirmUpdate?: (info: UpdateInfo) => Promise<{ ok: boolean }>
  onUpdateReady?: (fn: (info: UpdateInfo) => void) => () => void
}

function bridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined
  const electron = (window as unknown as { electron?: { devcode?: Bridge } }).electron
  return electron?.devcode
}

// Persisted-dismiss key so the attention animation plays once per version.
// Second launch with the same pending update shows the pill without the loud
// pulse. Install success wipes both the key and the pill itself (the main
// process clears currentUpdate before quit).
const ACK_KEY = "devcode.update.ack.version"

export function DevcodeUpdateFab() {
  const [info, setInfo] = createSignal<UpdateInfo | undefined>(undefined)
  const [installing, setInstalling] = createSignal(false)
  const [err, setErr] = createSignal<string | undefined>(undefined)
  // `attention` drives the entry pulse — a ring that pulses 4× then fades,
  // and a brighter accent colour while it's active. Fires only the first
  // time a given version appears; subsequent launches of the same pending
  // version read the ack from localStorage and skip the pulse so the UI
  // doesn't nag on every open.
  const [attention, setAttention] = createSignal(false)
  let attentionTimer: ReturnType<typeof setTimeout> | undefined

  const announce = (next: UpdateInfo) => {
    setInfo(next)
    let acked: string | null = null
    try { acked = localStorage.getItem(ACK_KEY) } catch { /* private mode */ }
    if (acked !== next.version) {
      setAttention(true)
      if (attentionTimer) clearTimeout(attentionTimer)
      // Pulse for 10s on first appearance — long enough to catch the eye
      // without crossing into "flashing banner ad" territory.
      attentionTimer = setTimeout(() => setAttention(false), 10_000)
    }
  }

  onMount(() => {
    const b = bridge()
    if (!b) return
    // Poll on mount in case the ready event already fired before the FAB
    // subscribed (first-launch race: update downloads during the ~30s
    // initial-delay window, user activates license, renderer mounts).
    void b.updateStatus?.().then((s) => {
      if (s?.ready && s.version) announce({ version: s.version })
    })
    const unsub = b.onUpdateReady?.((next) => announce(next))
    onCleanup(() => {
      try { unsub?.() } catch { /* ignore */ }
      if (attentionTimer) clearTimeout(attentionTimer)
    })
  })

  const trigger = async () => {
    const b = bridge()
    if (!b?.installUpdate) return
    const v = info()?.version ?? ""

    // Route the confirm through main's dialog.showMessageBox when available;
    // fall back to renderer confirm() on older desktop builds that predate
    // the confirmUpdate bridge. The native path is the reliable one — the
    // renderer confirm() has been observed to no-op silently in sandboxed
    // Chromium contexts, which reads as "nothing happens when I click".
    // Remember that the user has seen this version so a later launch with
    // the same pending update renders the pill without the pulse ring.
    // Written BEFORE the confirm so even a "Later" click counts as seen.
    try { localStorage.setItem(ACK_KEY, v) } catch { /* private mode */ }
    setAttention(false)

    let ok = false
    if (b.confirmUpdate) {
      const r = await b.confirmUpdate({ version: v }).catch(() => ({ ok: false }))
      ok = !!r?.ok
    } else {
      // Fallback confirm for older desktop builds without the native
      // bridge. Deliberately generic — no notes, no changelog, no "what's
      // new". The whole point of the scrub is that nothing about the
      // update's contents reaches the user.
      // eslint-disable-next-line no-alert
      ok = confirm(`Install version ${v}?\n\nOpenCode Dev will close and reopen.`)
    }
    if (!ok) return

    setInstalling(true)
    setErr(undefined)
    const r = await b.installUpdate().catch((e) => ({ ok: false, message: (e as Error).message }))
    if (!r?.ok) {
      setInstalling(false)
      setErr(r?.message || "install failed")
      // Clear the err toast after a few seconds so the pill reads "Update to vX" again.
      setTimeout(() => setErr(undefined), 5000)
      return
    }
    // On ok: the main process spawned the installer + will app.quit() in ~800ms.
    // The pill stays in "Installing…" state until the window dies. If the
    // process is STILL alive 15s later, the installer never actually started
    // (UAC denied after the pid came back, antivirus intercept, Inno Setup
    // silent-exit on a version check). Surface a real error instead of
    // leaving the user staring at "Installing…" forever.
    setTimeout(() => {
      if (installing()) {
        setInstalling(false)
        setErr("install didn't finish — try again, or check UAC / antivirus")
        setTimeout(() => setErr(undefined), 8000)
      }
    }, 15000)
  }

  return (
    <Show when={info()}>
      <div class="oc-update-wrap">
        {/* Attention pulse. A soft accent-coloured ring expanding out from
            behind the pill and fading. Pointer-events: none so it never eats
            clicks intended for the button underneath. Rendered sibling, not
            child, so the pill's own transition doesn't clip the ring. */}
        <Show when={attention() && !installing() && !err()}>
          <span
            aria-hidden="true"
            class="pointer-events-none absolute inset-0 rounded-lg border border-v2-border-border-focus"
          />
        </Show>
      <button
        data-slot="devcode-update-pill"
        type="button"
        onClick={trigger}
        disabled={installing()}
        aria-busy={installing()}
        aria-label={err() ?? `Install update ${info()!.version}`}
        title={err() ?? `Install version ${info()!.version}`}
        class="group relative inline-flex h-8 items-center gap-1.5 rounded-full border bg-v2-background-bg-layer-02 px-3 text-[11px] leading-4 font-[530] shadow-sm transition-[background-color,border-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none"
        classList={{
          // Default: accent-tinted so it reads as a positive affordance distinct
          // from the neutral Reset / License pills next to it.
          "border-v2-border-border-focus text-v2-text-text-accent hover:bg-v2-background-bg-layer-03": !err() && !attention(),
          // Attention state — brighter background, slightly thicker ring,
          // same hover affordance. Drops back to the default style after the
          // 10s attention window elapses or the user interacts.
          "border-v2-border-border-focus ring-1 ring-v2-text-text-accent/60 bg-v2-background-bg-layer-03 text-v2-text-text-accent font-semibold hover:bg-v2-background-bg-layer-03": !err() && attention() && !installing(),
          "border-v2-state-fg-danger! text-v2-state-fg-danger! hover:bg-v2-state-bg-danger!": !!err(),
        }}
  
      >
        <span class="flex h-4 w-4 shrink-0 items-center justify-center">
          <Show
            when={!installing()}
            fallback={
              <span
                aria-hidden="true"
                class="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-80"
              />
            }
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path d="M8 2v8" />
              <path d="M4.5 7l3.5 3.5L11.5 7" />
              <path d="M2.5 13h11" />
            </svg>
          </Show>
        </span>
        <span class="whitespace-nowrap">
          {err() ? err() : installing() ? "Installing…" : `Update to v${info()!.version}`}
        </span>
      </button>
      </div>
    </Show>
  )
}
