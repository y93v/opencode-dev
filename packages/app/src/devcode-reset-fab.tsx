import { createStore } from "solid-js/store"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useServers } from "@/runtime/server/registry"
import { authTokenFromCredentials } from "@/runtime/server/api"

type LicenseStatus = { active: false } | { active: true }

function licenseStatus() {
  if (typeof window === "undefined") return undefined
  const electron = (window as unknown as { electron?: { devcode?: { licenseStatus?: () => Promise<LicenseStatus> } } })
    .electron
  return electron?.devcode?.licenseStatus
}

// DevCode website pill. Rendered to the right of the Usage reset pill at
// the bottom-left corner of the renderer. Shelling to the OS browser via
// an anchor with target="_blank" routes through Electron's main-process
// `handleWillNavigate → shell.openExternal`, so the link opens in the user's
// default browser instead of hijacking the renderer window.
function openWebsite() {
  if (typeof window === "undefined") return
  const bridge = (window as unknown as { electron?: { devcode?: { openWebsite?: () => Promise<unknown> } } }).electron
    ?.devcode
  void bridge?.openWebsite?.()
}

export function DevcodeWebsiteFab() {
  return (
    <button
      type="button"
      data-slot="devcode-website-pill"
      onClick={openWebsite}
      aria-label="Open example.com"
      title="Visit example.com"
      class="group fixed bottom-4 left-[9.5rem] z-[9999] inline-flex h-8 cursor-pointer appearance-none items-center gap-1.5 rounded-full border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 text-[11px] leading-4 font-[530] text-v2-text-text-muted no-underline shadow-sm transition-[background-color,border-color,color] duration-150 ease-out hover:border-v2-border-border-base hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus motion-reduce:transition-none [app-region:no-drag]"
      
    >
      <span class="flex h-4 w-4 shrink-0 items-center justify-center">
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
          <circle cx="8" cy="8" r="6.5" />
          <path d="M1.5 8h13" />
          <path d="M8 1.5c1.8 2 2.75 4.1 2.75 6.5S9.8 12.5 8 14.5" />
          <path d="M8 1.5c-1.8 2-2.75 4.1-2.75 6.5S6.2 12.5 8 14.5" />
        </svg>
      </span>
      <span class="whitespace-nowrap">example.com</span>
    </button>
  )
}

// DevCode Fresh pill. Pinned to the bottom-left corner so it clears the
// Windows window chrome (min / max / close at top-right) and the composer
// (bottom-right).
//
// Pill = FAST mode, always. Closes the current desktop, rotates the egress
// IP via WARP/Tor, relaunches. Session, drafts, and window layout survive
// the rotation. Bets opencode.ai's anonymous bucket is IP-keyed, which
// matches field observation on comparable tools.
//
// The deep ritual (wipe DB + Electron Local Storage + drafts + window state)
// used to be bound to shift+click here, but it was indistinguishable from a
// stuck modifier and the resulting first-launch onboarding looked like the
// pill was broken. It now lives only on the Start Menu's `devcode-Fresh-
// Desktop` shortcut, which is explicit about what it does.
//
// The backend handler shells out to shortcuts/devcode-Fresh-Desktop.bat
// with DEVCODE_FRESH_MODE=fast in the env; this window goes down ~500 ms
// later as part of that script, so the pill shows a short "Resetting…"
// state before the window dies and the new one takes its place.
export function DevcodeResetFab() {
  const servers = useServers()
  const [licensed, setLicensed] = createSignal(false)
  onMount(() => {
    let alive = true
    const refresh = async () => {
      try {
        const status = await licenseStatus()?.()
        if (alive) setLicensed(status?.active === true)
      } catch {
        if (alive) setLicensed(false)
      }
    }
    void refresh()
    const warmup = window.setTimeout(() => void refresh(), 750)
    const id = window.setInterval(() => void refresh(), 5_000)
    const focus = () => void refresh()
    window.addEventListener("focus", focus)
    onCleanup(() => {
      alive = false
      window.clearTimeout(warmup)
      window.clearInterval(id)
      window.removeEventListener("focus", focus)
    })
  })
  const [s, set] = createStore({
    running: false,
    done: false,
    failed: false,
    count: 0,
    errorMsg: "" as string,
    phase: "" as "" | "reset",
  })
  const trigger = async () => {
    // ALWAYS fast. The shift+click → deep ritual used to live here but it
    // was indistinguishable from a stuck modifier key or an accidental
    // shift-hold, and the first-launch onboarding running on relaunch
    // looked identical to "the pill is broken". If someone genuinely needs
    // the full deep wipe (DB rows + Electron profile + credentials), the
    // Start Menu's `devcode-Fresh-Desktop` shortcut runs the ps1 directly
    // with -SkipReset:$false and no mode override — same ritual, but off
    // the pill where misclicks can't hit it.
    set({ running: true, done: false, failed: false, count: 0, errorMsg: "", phase: "reset" })
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        for (let i = window.localStorage.length - 1; i >= 0; i--) {
          const k = window.localStorage.key(i)
          if (k && (k.includes("free-limit") || k.includes("limit"))) {
            window.localStorage.removeItem(k)
          }
        }
      }
    } catch {}
    let hit = 0
    let lastError = ""
    let serverCount = 0
    let sidecarRestarting = false
    try {
      for (const conn of servers.list) {
        if (!("http" in conn) || !conn.http?.url) continue
        serverCount++
        const headers: Record<string, string> = { "content-type": "application/json" }
        if (conn.http.password)
          headers.authorization = `Basic ${authTokenFromCredentials({ password: conn.http.password })}`

        // Snapshot first. VACUUM INTO <data>/opencode/session-backups/
        // sessions-<stamp>.db gives a self-contained copy of every table so
        // a restore prompt on the next launch can offer to carry sessions
        // across the reset. Done BEFORE the destructive wipe so a failing
        // snapshot aborts the whole flow instead of losing work silently.
        // Export failure is a 500 from the sidecar (can't create backup
        // dir, vacuum failed); treat it the same as any other pre-reset
        // error. The handler already preserves credentials across the
        // wipe, so auth survives independently of the snapshot.
        // Snapshot before wipe. Previously a 500 from the sidecar here
        // short-circuited the whole flow with `continue`, so a disk-space
        // or VACUUM-INTO failure during backup ate the reset without
        // rotating the egress IP. The user clicked once, saw "snapshot
        // failed: ...", lost the WARP rotation too. Snapshot is a nice-
        // to-have; the reset itself (DB wipe + WARP rotate) must not
        // depend on it. Log the failure to the browser console and keep
        // going — the handler already preserves credentials and the
        // zeroed-counters path is what the user is actually asking for.
        try {
          const exportUrl = new URL(`/_devcode/export-sessions`, conn.http.url)
          const exportResponse = await fetch(exportUrl, { method: "POST", headers })
          if (!exportResponse.ok) {
            let msg = ""
            try {
              const body = (await exportResponse.json()) as { error?: string }
              if (body?.error) msg = body.error
            } catch {}
            if (!msg) msg = `export HTTP ${exportResponse.status}`
            // eslint-disable-next-line no-console
            console.warn(`[devcode-reset] snapshot failed, continuing with reset: ${msg}`)
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[devcode-reset] snapshot threw, continuing with reset:`, e)
        }

        // Pill ships mode=fresh&preserve=0: full ritual, no session carry-
        // over. Earlier builds passed preserve=1 (implicit) to keep tabs
        // open across the reset, but the preserved session row carried
        // identifiers (project_id, timestamps, metadata the server keys
        // quota on) that leaked the pre-reset identity. Full wipe is the
        // only shape that reads as a first-ever install to opencode.ai.
        // Chat history is still exported to <data>/opencode/session-
        // backups/<ts>.db by the export-sessions call fired right before
        // this one, so losing the live rows isn't data loss — just a UI
        // reset.
        const url = new URL(`/_devcode/reset-limits?mode=fresh&preserve=0`, conn.http.url)
        // No `credentials: "include"`: Electron's main process injects the
        // sidecar Authorization header for every renderer→loopback request
        // (see packages/desktop/src/main/windows/security.ts), and adding
        // credentials here forces a CORS preflight the server does not allow.
        const response = await fetch(url, { method: "POST", headers })
        if (response.ok) {
          // Read body FIRST so we can tell real success from a catchCause
          // fallback (ok:false with handler_error). Only count as a hit
          // when body.ok is truthy; otherwise fall through to the error
          // path so the pill shows "failed" and we don't reload into a
          // broken state.
          type ResetBody = {
            ok?: boolean
            warp?: {
              status?: string
              ip_before?: string | null
              ip_after?: string
              reason?: string
              error?: string
              step?: string
            }
            sessions_restored?: number
            sidecar_restarting?: boolean
            handler_error?: string
            error?: string
          }
          let body: ResetBody | null = null
          try {
            body = (await response.json()) as ResetBody
          } catch {
            /* non-json body */
          }
          if (body && body.ok === false) {
            lastError = body.error || body.handler_error || "reset failed"
            continue
          }
          hit++
          sidecarRestarting = sidecarRestarting || !!body?.sidecar_restarting
          const chats = body?.sessions_restored ?? 0
          const warp = body?.warp
          const bits: string[] = []
          if (chats > 0) bits.push(`${chats} chat${chats === 1 ? "" : "s"} kept`)
          if (warp?.status === "rotated" && warp.ip_after) {
            bits.push(`IP ${warp.ip_before ?? "?"} → ${warp.ip_after}`)
          } else if (warp?.status === "unverified" && warp.ip_after) {
            bits.push(`IP unverified (now ${warp.ip_after})`)
          } else if (warp?.status === "skipped") {
            bits.push(`WARP skipped: ${warp.reason ?? "(no reason)"}`)
          } else if (warp?.status === "failed") {
            bits.push(`WARP ${warp.step ?? "?"}: ${warp.error ?? "failed"}`)
          }
          if (body?.sidecar_restarting) bits.push("sidecar restarting…")
          lastError = bits.join(" · ")
          continue
        }
        // Prefer a backend-supplied error message. When the response has no
        // parseable JSON body (common for 404/405/method-not-allowed), fall
        // back to the HTTP status so the user sees something actionable
        // instead of a generic "no servers". "no servers" used to swallow
        // every 4xx — a 405 on an un-registered /_devcode route is a very
        // different problem from zero servers in the list.
        let msg = ""
        try {
          const body = (await response.json()) as { error?: string }
          if (body?.error) msg = body.error
        } catch {}
        if (!msg) msg = `HTTP ${response.status}`
        lastError = msg
      }
      if (hit === 0) {
        // Three distinguishable failure modes: no servers were registered,
        // a server was there but every request failed, or something else.
        if (serverCount === 0) throw new Error("no backend connected — open a project first")
        throw new Error(lastError || "reset failed")
      }
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          for (let i = window.localStorage.length - 1; i >= 0; i--) {
            const k = window.localStorage.key(i)
            if (k && (k.includes("free-limit") || k.includes("limit"))) {
              window.localStorage.removeItem(k)
            }
          }
        }
      } catch {}
      set({ running: false, done: true, failed: false, count: hit, errorMsg: lastError, phase: "" })
      // Dwell: 5s if the sidecar is self-restarting (lets Electron respawn
      // + reconnect handshake finish before the renderer reloads), 3s
      // otherwise. The flag comes from the body we parsed above — no
      // string-sniffing the human-readable summary.
      setTimeout(() => {
        if (typeof window !== "undefined") {
          window.location.reload()
        }
      }, sidecarRestarting ? 4000 : 2500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : lastError || "reset failed"
      set({ running: false, done: false, failed: true, count: 0, errorMsg: msg, phase: "" })
      setTimeout(
        () => set({ running: false, done: false, failed: false, count: 0, errorMsg: "", phase: "" }),
        6000,
      )
    }
  }
  const label = () => {
    if (s.running) return "Resetting…"
    if (s.done) return "Reset ✓"
    if (s.failed) {
      if (!s.errorMsg) return "Retry"
      // Short label on the fixed-width pill; full error available on hover
      // via the `title` attribute set on the button element.
      return s.errorMsg.length > 16 ? s.errorMsg.slice(0, 13) + "…" : s.errorMsg
    }
    return "Usage reset"
  }
  return (
    <button
      data-slot="devcode-reset-pill"
      type="button"
      onClick={() => trigger()}
      disabled={s.running || s.done}
      aria-busy={s.running}
      aria-label="Reset usage and restart with a fresh client identity"
      title={s.errorMsg || undefined}
      class="group fixed bottom-4 left-4 z-[9999] inline-flex h-8 w-[8rem] items-center gap-1.5 rounded-full border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 text-[11px] leading-4 font-[530] text-v2-text-text-muted shadow-sm transition-[background-color,border-color,color] duration-150 ease-out hover:border-v2-border-border-base hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none [app-region:no-drag]"
      classList={{
        "border-v2-state-fg-danger! text-v2-state-fg-danger! hover:bg-v2-state-bg-danger!": s.failed,
        "border-v2-text-text-success! text-v2-text-text-success!": s.done,
      }}
      style={{ display: licensed() ? undefined : "none" }}
    >
      <span class="flex h-4 w-4 shrink-0 items-center justify-center">
        <Show
          when={!s.running}
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
            <Show
              when={s.done}
              fallback={
                <Show
                  when={s.failed}
                  fallback={
                    <>
                      <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
                      <path d="M13.5 3v3h-3" />
                    </>
                  }
                >
                  <path d="M8 3v5" />
                  <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
                </Show>
              }
            >
              <path d="M3 8.5l3 3 7-7" />
            </Show>
          </svg>
        </Show>
      </span>
      <span class="whitespace-nowrap">{label()}</span>
    </button>
  )
}
