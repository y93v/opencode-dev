import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Textarea } from "@opencode/ui/textarea"
import { useDialog } from "@opencode/ui/context/dialog"
import { authTokenFromCredentials } from "@/runtime/server/api"
import { useServers } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"

// DevCode Auto JB toggle. When on, every model request carries the active
// Auto JB instruction set instead of the workspace AGENTS.md. The setting and
// the user's custom instructions live next to the other DevCode state in the
// server data directory, so they survive restarts and are shared by the CLI
// and the desktop.
export function DevcodeAbliteratedToggle() {
  const servers = useServers()
  const language = useLanguage()
  const dialog = useDialog()
  const [enabled, setEnabled] = createSignal(false)
  const [available, setAvailable] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  // Reactive so a sidecar restart (reset rotates the password) re-reads the
  // setting instead of leaving the button pointed at a dead connection.
  const connection = createMemo(() => {
    const conn = servers.list.find((item) => "http" in item && item.http?.url)
    return conn && "http" in conn ? conn : undefined
  })

  const headers = (conn = connection()) => {
    if (!conn?.http) return undefined
    const result: Record<string, string> = {}
    if (conn.http.password) {
      result.authorization = `Basic ${authTokenFromCredentials({ password: conn.http.password })}`
    }
    return result
  }

  const refresh = async () => {
    const conn = connection()
    if (!conn?.http?.url) return
    try {
      const response = await fetch(new URL("/_devcode/abliterated", conn.http.url), {
        headers: headers(conn),
      })
      if (!response.ok) return
      const body = (await response.json()) as { enabled?: boolean }
      setEnabled(body.enabled === true)
      setAvailable(true)
    } catch {
      /* server not up yet */
    }
  }

  // Re-read whenever the active server connection changes so a restarted
  // sidecar (new password, new port) is picked up without a remount.
  createEffect(() => {
    if (!connection()) return
    void refresh()
  })

  const toggle = async () => {
    const conn = connection()
    if (!conn?.http?.url || busy()) return
    const next = !enabled()
    setBusy(true)
    try {
      const response = await fetch(
        new URL(`/_devcode/abliterated?enabled=${next ? 1 : 0}`, conn.http.url),
        { method: "POST", headers: headers(conn) },
      )
      if (!response.ok) return
      const body = (await response.json()) as { ok?: boolean; enabled?: boolean }
      if (body.ok) setEnabled(body.enabled === true)
      setAvailable(true)
    } finally {
      setBusy(false)
    }
  }

  const edit = () => {
    const conn = connection()
    if (!conn?.http?.url) return
    dialog.show(() => (
      <AutoJbEditor
        url={conn.http.url}
        headers={headers(conn)}
        onSaved={() => void refresh()}
      />
    ))
  }

  return (
    <div class="flex items-center gap-0.5">
      <Button
        data-slot="devcode-abliterated-toggle"
        type="button"
        variant="ghost-muted"
        size="normal"
        class="gap-1.5"
        style={{ height: "28px" }}
        classList={{ "text-v2-state-fg-success!": enabled() }}
        aria-pressed={enabled()}
        aria-label="Toggle Auto JB project AGENTS.md"
        title={enabled() ? "Auto JB AGENTS.md is the active project instruction" : "Use the workspace AGENTS.md"}
        disabled={!available() || busy()}
        onClick={toggle}
      >
        <span class="whitespace-nowrap">Auto JB</span>
        <span
          class="relative flex h-3.5 w-6 shrink-0 items-center rounded-full border border-current/30 transition-colors"
          classList={{ "bg-v2-state-bg-success!": enabled() }}
          aria-hidden="true"
        >
          <span
            class="absolute h-2.5 w-2.5 rounded-full bg-current transition-transform duration-150"
            classList={{
              "translate-x-2.5": enabled(),
              "translate-x-0.5": !enabled(),
            }}
          />
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost-muted"
        size="normal"
        style={{ height: "28px", width: "28px", padding: "0" }}
        aria-label={language.t("user.autoJb.edit")}
        title={language.t("user.autoJb.edit")}
        disabled={!available()}
        onClick={edit}
      >
        <Icon name="edit" size="small" />
      </Button>
    </div>
  )
}

// Saved sets live in the renderer; the active set still lives in the sidecar
// file the CLI reads. That keeps the library local and the behaviour shared.
type AutoJbPreset = { id: string; name: string; content: string }

const PRESET_KEY = "devcode.autoJb.presets"
const MAX_PRESETS = 25

function readPresets(): AutoJbPreset[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PRESET_KEY)
    if (!raw) return []
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const preset = item as Partial<AutoJbPreset>
      if (typeof preset.id !== "string" || typeof preset.name !== "string" || typeof preset.content !== "string") return []
      return [{ id: preset.id, name: preset.name, content: preset.content }]
    })
  } catch {
    return []
  }
}

function storePresets(list: AutoJbPreset[]) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PRESET_KEY, JSON.stringify(list))
  } catch {
    /* quota or private mode: the list still works for this session */
  }
}

function AutoJbEditor(props: {
  url: string
  headers?: Record<string, string>
  onSaved: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [content, setContent] = createSignal("")
  const [, setFallback] = createSignal("")
  const [custom, setCustom] = createSignal(false)
  const [max, setMax] = createSignal(1_000_000)
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [presets, setPresets] = createSignal<AutoJbPreset[]>(readPresets())
  const [selected, setSelected] = createSignal("default")
  const [naming, setNaming] = createSignal(false)
  const [presetName, setPresetName] = createSignal("")
  const [confirmPreset, setConfirmPreset] = createSignal(false)
  const [confirmPrompt, setConfirmPrompt] = createSignal(false)

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(new URL("/_devcode/abliterated/content", props.url), {
        headers: props.headers,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as {
        content?: string
        default?: string
        custom?: boolean
        max?: number
      }
      setContent(body.content ?? "")
      setFallback(body.default ?? "")
      setCustom(body.custom === true)
      if (typeof body.max === "number" && body.max > 0) setMax(body.max)
      // Older sidecars do not report the active preset; match by content.
      setSelected(
        body.custom !== true
          ? "default"
          : presets().find((preset) => preset.content === body.content)?.id ?? "custom",
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const persist = async (value: string, selection: string, reset = false) => {
    if (busy()) return false
    if (!reset && value.length > max()) {
      setError(language.t("user.autoJb.tooLarge", { count: max() }))
      return false
    }
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch(new URL("/_devcode/abliterated/content", props.url), {
        method: "POST",
        headers: { ...props.headers, "content-type": "application/json" },
        body: JSON.stringify(reset ? { reset: true } : { content: value }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        custom?: boolean
      }
      if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      if (reset) {
        // The server restores the bundled text; reload it instead of leaving
        // the editor blank after "Default".
        await load()
        props.onSaved()
        return true
      }
      setContent(value)
      setCustom(body.custom === true)
      setSelected(body.custom === true ? selection : "default")
      props.onSaved()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (await persist(content(), selected())) dialog.close()
  }

  const pick = (id: string) => {
    if (id === "custom") return
    const value = id === "default" ? undefined : presets().find((preset) => preset.id === id)?.content
    setConfirmPreset(false)
    setConfirmPrompt(false)
    if (id === "default") {
      void persist("", "default", true)
      return
    }
    if (value === undefined) return
    void persist(value, id)
  }

  const editContent = (value: string) => {
    setContent(value)
    if (selected() !== "custom") setSelected("custom")
  }

  const presetId = () => {
    // crypto.randomUUID needs a secure context and is missing from older
    // Electron/WebKit builds on Linux; fall back to a time+random id.
    const uuid = globalThis.crypto?.randomUUID
    if (typeof uuid === "function") return uuid.call(globalThis.crypto)
    return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  const savePreset = async () => {
    const trimmed = presetName().trim()
    if (!trimmed || busy()) return
    const list = presets()
    const existing = list.find((preset) => preset.name.toLowerCase() === trimmed.toLowerCase())
    const preset: AutoJbPreset = {
      id: existing?.id ?? presetId(),
      name: trimmed,
      content: content(),
    }
    const next = existing
      ? list.map((item) => (item.id === existing.id ? preset : item))
      : [...list, preset].slice(-MAX_PRESETS)
    setPresets(next)
    storePresets(next)
    setPresetName("")
    setNaming(false)
    await persist(preset.content, preset.id)
  }

  const removePreset = () => {
    const id = selected()
    if (id === "default" || id === "custom") return
    const next = presets().filter((preset) => preset.id !== id)
    setPresets(next)
    storePresets(next)
    setSelected("custom")
    setConfirmPreset(false)
  }

  const deletePrompt = async () => {
    if (!confirmPrompt()) {
      setConfirmPrompt(true)
      return
    }
    setConfirmPrompt(false)
    await persist("", "default", true)
  }

  const activePreset = () => presets().find((preset) => preset.id === selected())

  return (
    <Dialog size="large" containerClass="!h-[min(640px,86vh)] !w-[min(820px,92vw)]">
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("user.autoJb.title")}
          description={language.t("user.autoJb.description")}
        />
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-col gap-2 px-4 pb-1">
        <Show when={error()}>
          {(message) => (
            <div class="rounded-[6px] border border-v2-border-border-muted bg-v2-state-bg-danger/10 px-3 py-2 text-[12px] text-v2-state-fg-danger">
              {language.t("user.autoJb.error")} {message()}
            </div>
          )}
        </Show>
        <div class="flex items-center gap-2">
          <label class="text-[11px] text-v2-text-text-muted" for="autojb-preset">
            {language.t("user.autoJb.presetLabel")}
          </label>
          <select
            id="autojb-preset"
            value={selected()}
            disabled={busy() || loading()}
            onChange={(event) => pick(event.currentTarget.value)}
            class="h-7 min-w-0 flex-1 rounded-[6px] border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
          >
            <option value="default">{language.t("user.autoJb.presetDefault")}</option>
            <For each={presets()}>
              {(preset) => <option value={preset.id}>{preset.name}</option>}
            </For>
            <Show when={selected() === "custom"}>
              <option value="custom">{language.t("user.autoJb.presetCustom")}</option>
            </Show>
          </select>
          <Button
            variant="ghost"
            disabled={busy() || loading()}
            onClick={() => {
              setPresetName(activePreset()?.name ?? "")
              setNaming(!naming())
            }}
          >
            {language.t("user.autoJb.presetSave")}
          </Button>
          <Button
            variant="ghost"
            disabled={busy() || loading() || !content()}
            aria-label={language.t("user.autoJb.clear")}
            title={language.t("user.autoJb.clear")}
            onClick={() => editContent("")}
          >
            {language.t("user.autoJb.clear")}
          </Button>
          <Button
            variant="ghost"
            disabled={busy() || !activePreset()}
            aria-label={language.t("user.autoJb.delete")}
            title={language.t("user.autoJb.delete")}
            onClick={() => {
              if (!confirmPreset()) return setConfirmPreset(true)
              setConfirmPreset(false)
              removePreset()
            }}
          >
            {confirmPreset()
              ? language.t("user.autoJb.deletePresetConfirm")
              : language.t("user.autoJb.delete")}
          </Button>
        </div>
        <Show when={naming()}>
          <div class="flex items-center gap-2">
            <input
              value={presetName()}
              autofocus
              maxlength={80}
              placeholder={language.t("user.autoJb.presetName")}
              onInput={(event) => setPresetName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void savePreset()
                if (event.key === "Escape") setNaming(false)
              }}
              class="h-7 min-w-0 flex-1 rounded-[6px] border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
            />
            <Button variant="submit" disabled={busy() || !presetName().trim()} onClick={() => void savePreset()}>
              {language.t("user.autoJb.save")}
            </Button>
            <Button variant="ghost" onClick={() => setNaming(false)}>
              {language.t("user.autoJb.cancel")}
            </Button>
          </div>
        </Show>
        <Textarea
          class="!w-full !flex-1 min-h-0 [&_textarea]:h-full [&_textarea]:min-h-0 [&_textarea]:resize-none [&_textarea]:font-mono [&_textarea]:text-[12px] [&_textarea]:leading-5"
          value={content()}
          disabled={loading() || busy()}
          rows={18}
          spellcheck={false}
          placeholder={language.t("user.autoJb.placeholder")}
          onInput={(event) => editContent(event.currentTarget.value)}
        />
        <div class="flex items-center justify-between text-[11px] text-v2-text-text-muted">
          <span>
            {language.t(custom() ? "user.autoJb.custom" : "user.autoJb.default")} ·{" "}
            {language.t("user.autoJb.characters", { count: content().length })}
          </span>
          <Show when={content().length > max()}>
            <span class="text-v2-state-fg-danger">{language.t("user.autoJb.tooLarge", { count: max() })}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <Show when={custom() || activePreset()}>
          <Button variant="ghost" disabled={busy() || loading()} onClick={() => void deletePrompt()}>
            {confirmPrompt() ? language.t("user.autoJb.deleteConfirm") : language.t("user.autoJb.deletePrompt")}
          </Button>
        </Show>
        <Button variant="ghost" disabled={busy() || loading()} onClick={() => pick("default")}>
          {language.t("user.autoJb.reset")}
        </Button>
        <div class="flex-1" />
        <Button variant="ghost" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("user.autoJb.cancel")}
        </Button>
        <Button
          variant="submit"
          disabled={busy() || loading() || content().length > max()}
          onClick={() => void save()}
        >
          {busy() ? language.t("user.autoJb.saving") : language.t("user.autoJb.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
