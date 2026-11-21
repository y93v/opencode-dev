import { createSignal, onCleanup, onMount, Show } from "solid-js"

// DevCode License pill. Pinned to the bottom-left alongside the Reset and
// example.com pills. Three states:
//
//   inactive  – shows "License" + lock icon, clicking opens the activation
//               dialog. No prefix, no countdown (there is none).
//   active    – shows the masked key prefix + days-left badge, colour-coded:
//               green >7d, amber 3-7d, red ≤3d. Clicking anywhere on the
//               pill except the eye opens the full management dialog.
//   loading   – first render before the main process has answered. Shows
//               an animated placeholder so the pill doesn't flash in.
//
// Eye toggle: starts hidden (dots). Click the eye to reveal the masked
// prefix ("A5B2X…9KLM"); click again to hide. The toggle only affects the
// pill's own render — the full key never crosses the preload boundary.
// Status is polled every 60s so a countdown stays live without the user
// having to re-open anything.

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

type LicenseBridge = {
  openLicenseManage?: () => Promise<unknown>
  licenseStatus?: () => Promise<LicenseStatus>
  licenseFullKey?: () => Promise<{ active: true; key: string } | { active: false; reason?: string }>
}

function bridge(): LicenseBridge | undefined {
  if (typeof window === "undefined") return undefined
  const electron = (window as unknown as { electron?: { devcode?: LicenseBridge } }).electron
  return electron?.devcode
}

const POLL_MS = 60_000

function daysColour(days: number, expiresAt: number): { tone: string; label: string } {
  // No expiry = lifetime / open-ended / worker didn't populate yet.
  // Render neutral "active" instead of the misleading "expired" that
  // falls out of days === 0.
  if (!expiresAt || expiresAt <= 0) return { tone: "text-v2-text-text-muted", label: "active" }
  if (days <= 0) return { tone: "text-v2-red-500", label: "expired" }
  if (days <= 3) return { tone: "text-v2-red-500", label: `${days}d left` }
  if (days <= 7) return { tone: "text-v2-yellow-500", label: `${days}d left` }
  return { tone: "text-v2-green-500", label: `${days}d left` }
}

export function DevcodeLicenseFab() {
  const [status, setStatus] = createSignal<LicenseStatus | "loading">("loading")
  // revealed = full key fetched and shown inline. The key string lives in
  // this signal only while the eye is open; toggling off clears it so the
  // secret has the shortest possible residency in renderer memory /
  // devtools inspection. Fetch happens on every reveal (cheap IPC round
  // trip to the main process), so there is no stale copy to leak if the
  // user swaps the key between opens.
  const [revealed, setRevealed] = createSignal<string | null>(null)
  const [, setRevealing] = createSignal(false)

  const refresh = async () => {
    const fn = bridge()?.licenseStatus
    if (!fn) {
      setStatus({ active: false, reason: "bridge unavailable" })
      return
    }
    try {
      const next = await fn()
      setStatus(next)
    } catch (e) {
      setStatus({ active: false, reason: e instanceof Error ? e.message : "status unavailable" })
    }
  }

  onMount(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => window.clearInterval(id))
  })

  const available = () => typeof bridge()?.openLicenseManage === "function"
  const openManage = () => {
    const open = bridge()?.openLicenseManage
    if (!open) return
    void open().catch(() => undefined)
    // Re-poll shortly after the dialog closes so a deactivate / swap is
    // reflected in the pill without the user having to click anything.
    window.setTimeout(() => void refresh(), 1500)
  }

  return (
    <div
      data-slot="devcode-license-pill"
      class="fixed bottom-4 left-[19rem] z-[9999] inline-flex h-8 items-center gap-1 rounded-full border border-v2-border-border-muted bg-v2-background-bg-layer-02 pl-3 pr-1.5 text-[11px] leading-4 font-[530] text-v2-text-text-muted shadow-sm transition-[background-color,border-color,color] duration-150 ease-out hover:border-v2-border-border-base hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base focus-within:outline-none focus-within:ring-2 focus-within:ring-v2-border-border-focus motion-reduce:transition-none [app-region:no-drag]"
      
    >
      <button
        type="button"
        onClick={openManage}
        disabled={!available()}
        aria-label="Open license management"
        title={available() ? "View license status, deactivate, or swap key" : "Open the Help menu → License… (Alt)"}
        class="group inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none"
      >
        <span class="flex h-4 w-4 shrink-0 items-center justify-center">
          <Show
            when={status() !== "loading"}
            fallback={
              <span
                aria-hidden="true"
                class="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70"
              />
            }
          >
            <Show
              when={(status() as LicenseStatus).active}
              fallback={
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
                  <rect x="3" y="7" width="10" height="7" rx="1.5" />
                  <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
                </svg>
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
                <circle cx="5" cy="11" r="2.75" />
                <path d="M7 9.2l6-6" />
                <path d="M10.5 5.7l2 2" />
              </svg>
            </Show>
          </Show>
        </span>
        <Show
          when={status() !== "loading" && (status() as LicenseStatus).active}
          fallback={<span class="whitespace-nowrap">License</span>}
        >
          {(() => {
            const s = status() as LicenseStatus & { active: true }
            const colour = daysColour(s.days_left, s.expires_at)
            // ALWAYS show the masked prefix in the pill. The full key lives
            // in a popover rendered below (outside this button) when the
            // eye is toggled, so the pill itself never changes width and
            // can't push into the Theme pill at left-[32rem].
            return (
              <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span class="font-mono tracking-[0.04em] text-v2-text-text-base">
                  •••••
                </span>
                <span
                  class={`inline-flex items-center rounded-full border border-current/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${colour.tone}`}
                  title={new Date(s.expires_at * 1000).toLocaleString()}
                >
                  {colour.label}
                </span>
              </span>
            )
          })()}
        </Show>
      </button>
      <Show when={status() !== "loading" && (status() as LicenseStatus).active}>
        <button
          type="button"
          onClick={async (e) => {
            e.stopPropagation()
            if (revealed() !== null) {
              setRevealed(null)
              return
            }
            const fn = bridge()?.licenseFullKey
            if (!fn) return
            setRevealing(true)
            try {
              const r = await fn()
              if (r.active && r.key) setRevealed(r.key)
            } catch {
              /* swallow; pill stays hidden */
            } finally {
              setRevealing(false)
            }
          }}
          aria-label={revealed() !== null ? "Hide license key" : "Reveal license key"}
          aria-pressed={revealed() !== null}
          title={revealed() !== null ? "Hide key" : "Reveal full key (click key to copy)"}
          class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base focus:outline-none focus:ring-1 focus:ring-v2-border-border-focus"
        >
          <Show
            when={revealed() !== null}
            fallback={
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
                <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
                <circle cx="8" cy="8" r="1.75" />
              </svg>
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
              <path d="M2.5 2.5l11 11" />
              <path d="M6.5 4a7 7 0 0 1 1.5-.2c4 0 6.5 4.2 6.5 4.2a12 12 0 0 1-1.9 2.4" />
              <path d="M3.4 5.7A12 12 0 0 0 1.5 8s2.5 4.2 6.5 4.2c.9 0 1.8-.2 2.5-.5" />
              <path d="M6.3 6.3a2.3 2.3 0 0 0 3.4 3.4" />
            </svg>
          </Show>
        </button>
      </Show>
      {/* Reveal popover — sits ABOVE the pill as its own fixed element so
          it can't change the pill's width (which was causing it to push
          into the Theme pill at left-[32rem]). Click the key to copy. */}
      <Show when={revealed() !== null}>
        <div
          class="oc-license-reveal max-w-[420px] rounded-xl border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3 shadow-xl [app-region:no-drag]"
          
        >
          <div class="mb-1 text-[10px] uppercase tracking-wider text-v2-text-text-faint">Your license key</div>
          <div class="flex items-center gap-2">
            <code
              class="flex-1 overflow-x-auto rounded-md border border-v2-border-border-muted bg-v2-background-bg-base px-2 py-1.5 text-[11px] font-mono tracking-[0.04em] text-v2-text-text-base select-text"
              title="Click to copy"
              onClick={(e) => {
                const k = revealed()
                if (!k) return
                e.stopPropagation()
                void navigator.clipboard?.writeText(k).catch(() => undefined)
              }}
            >
              {revealed()}
            </code>
            <button
              type="button"
              aria-label="Copy license key"
              onClick={(e) => {
                e.stopPropagation()
                const k = revealed()
                if (k) void navigator.clipboard?.writeText(k).catch(() => undefined)
              }}
              class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
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
                <rect x="5" y="5" width="8" height="8" rx="1.5" />
                <path d="M3 10V3.5A1.5 1.5 0 0 1 4.5 2H10" />
              </svg>
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
