import { ANIMATED_THEMES, CURSORS, EFFECTS_STORAGE_KEY, readEffects, saveEffects, type CursorEffect } from "./devcode-effects"
import { useLanguage } from "./runtime/i18n/language"
import { DEVCODE_COPY } from "./devcode-copy"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { KITS, palette, themeKit, type ThemeKit } from "./devcode-themes"
import { applyTheme, readTheme } from "./devcode-theme-runtime"

function ThemeCard(props: { kit: ThemeKit; active: boolean; choose: () => void }) {
  const language = useLanguage()
  const colors = () => palette(props.kit)
  return (
    <button
      type="button"
      class="oc-theme-card"
      data-animated={ANIMATED_THEMES.includes(props.kit.id) ? "true" : undefined}
      aria-pressed={props.active}
      aria-label={
        (language.t("user.appearance.card", {
          name: props.kit.label,
          brightness: (
            language.t(props.kit.family === "dark" ? "user.appearance.dark" : "user.appearance.light") ||
            (props.kit.family === "dark" ? "Dark" : "Light")
          ).toLowerCase(),
        })) ||
        `${props.kit.label}, ${props.kit.family} theme`
      }
      onClick={props.choose}
      style={{
        "--preview-bg": props.kit.bg,
        "--preview-panel": colors()["bg-layer-02"],
        "--preview-accent": props.kit.accent,
      }}
    >
      <span class="oc-theme-preview" aria-hidden="true">
        <span class="oc-preview-sidebar">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span class="oc-preview-content">
          <span class="oc-preview-dots">•••</span>
          <i />
          <i />
          <span class="oc-preview-composer">
            <b>↗</b>
          </span>
        </span>
        <Show when={props.active}>
          <span class="oc-theme-check">✓</span>
        </Show>
      </span>
      <span class="oc-theme-caption">
        <strong>{props.kit.label}<Show when={ANIMATED_THEMES.includes(props.kit.id)}><small class="oc-motion-badge">{language.t("user.effects.animated") || "Animated"}</small></Show></strong>
        <span>{language.t(`user.appearance.tagline.${props.kit.id}` as keyof typeof DEVCODE_COPY) || props.kit.tagline}</span>
      </span>
    </button>
  )
}

export function DevcodeThemeFab() {
  const language = useLanguage()
  const [state, set] = createStore({ active: readTheme(), query: "", family: "all", open: false, effects: readEffects() })
  let dialog!: HTMLDialogElement
  let trigger!: HTMLButtonElement
  const results = createMemo(() =>
    KITS.filter(
      (kit) =>
        (state.family === "all" || (state.family === "animated" ? ANIMATED_THEMES.includes(kit.id) : kit.family === state.family)) &&
        `${kit.label} ${kit.tagline}`.toLowerCase().includes(state.query.trim().toLowerCase()),
    ),
  )
  const close = () => {
    dialog.close()
    set("open", false)
    trigger.focus()
  }
  onMount(() => {
    set("active", document.documentElement.dataset.devTheme ?? readTheme())
    // Re-read effects at mount in case they changed between createStore and
    // mount (another component's effect toggle, external storage event).
    set("effects", readEffects())
    const sync = () => set("active", document.documentElement.dataset.devTheme ?? readTheme())
    // Effects can change from another tab (storage) or another in-tab caller
    // of saveEffects (devcode:effects-changed). Without a listener here the
    // dialog's checkbox + select values go stale, and the next toggle writes
    // a stale `...state.effects` baseline back, clobbering the external
    // change. Mirror the same pattern installEffects already uses.
    const syncEffects = () => set("effects", readEffects())
    const onStorage = (event: StorageEvent) => {
      if (event.key === EFFECTS_STORAGE_KEY) syncEffects()
    }
    window.addEventListener("devcode:theme-changed", sync)
    window.addEventListener("devcode:effects-changed", syncEffects)
    window.addEventListener("storage", onStorage)
    onCleanup(() => {
      window.removeEventListener("devcode:theme-changed", sync)
      window.removeEventListener("devcode:effects-changed", syncEffects)
      window.removeEventListener("storage", onStorage)
    })
  })
  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="oc-theme-trigger"
        data-slot="devcode-theme-pill"
        aria-haspopup="dialog"
        aria-expanded={state.open}
        onClick={() => {
          set({ query: "", open: true })
          dialog.showModal()
        }}
      >
        <span class="oc-theme-dot" style={{ background: themeKit(state.active).accent }} aria-hidden="true" />
        <span>{language.t("user.appearance.open")}</span>
        <span class="oc-trigger-theme">{themeKit(state.active).label}</span>
      </button>
      <dialog
        ref={dialog}
        class="oc-appearance"
        aria-labelledby="oc-appearance-title"
        onCancel={(event) => {
          event.preventDefault()
          close()
        }}
        onClick={(event) => {
          if (event.target === dialog) {
            const r = dialog.getBoundingClientRect()
            if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)
              close()
          }
        }}
      >
        <header class="oc-appearance-header">
          <div>
            <span class="oc-eyebrow">{language.t("user.appearance.eyebrow")}</span>
            <h2 id="oc-appearance-title">{language.t("user.appearance.title")}</h2>
            <p>{language.t("user.appearance.description", { count: KITS.length })}</p>
          </div>
          <button type="button" class="oc-close" aria-label={language.t("user.appearance.close")} onClick={close}>
            ×
          </button>
        </header>
        <div class="oc-appearance-tools">
          <div class="oc-theme-filters" role="group" aria-label={language.t("user.appearance.brightness")}>
            <For each={["all", "dark", "light", "animated"]}>
              {(family) => (
                <button type="button" aria-pressed={state.family === family} onClick={() => set("family", family)}>
                  {language.t(
                    family === "all"
                      ? "user.appearance.all"
                      : family === "dark"
                        ? "user.appearance.dark"
                        : family === "animated" ? "user.effects.animated" : "user.appearance.light",
                  )}
                </button>
              )}
            </For>
          </div>
          <input
            autofocus
            type="search"
            aria-label={language.t("user.appearance.search")}
            placeholder={language.t("user.appearance.placeholder")}
            value={state.query}
            onInput={(event) => set("query", event.currentTarget.value)}
          />
        </div>
        <section class="oc-effects-controls" aria-label={language.t("user.effects.cursor")}>
          <label class="oc-motion-toggle"><input type="checkbox" checked={state.effects.motion} onChange={(event) => {
            const effects = { ...state.effects, motion: event.currentTarget.checked }; set("effects", effects); saveEffects(effects)
          }} />{language.t("user.effects.motion")}</label>
          <label class="oc-cursor-choice">{language.t("user.effects.cursor")}<select value={state.effects.cursor} onChange={(event) => {
            const effects = { ...state.effects, cursor: event.currentTarget.value as CursorEffect }; set("effects", effects); saveEffects(effects)
          }}><For each={CURSORS}>{(cursor) => <option value={cursor}>{language.t(`user.effects.${cursor}`)}</option>}</For></select></label>
          <span class="oc-effects-hint">{language.t("user.effects.reduced")}</span>
        </section>
        <div class="oc-theme-grid">
          <For each={results()}>
            {(kit) => (
              <ThemeCard
                kit={kit}
                active={state.active === kit.id}
                choose={() => {
                  applyTheme(kit.id)
                  set("active", kit.id)
                }}
              />
            )}
          </For>
          <Show when={!results().length}>
            <p class="oc-theme-empty">{language.t("user.appearance.empty")}</p>
          </Show>
        </div>
        <footer class="oc-appearance-footer">
          <span role="status">{language.t("user.appearance.selected", { name: themeKit(state.active).label })}</span>
          <button type="button" class="oc-done" onClick={close}>
            {language.t("user.appearance.done")}
          </button>
        </footer>
      </dialog>
    </>
  )
}
