import { useLanguage } from "./runtime/i18n/language"
import { onCleanup, onMount, type ParentProps } from "solid-js"

export function DevcodeToolbar(props: ParentProps) {
  const language = useLanguage()
  let element!: HTMLElement
  onMount(() => {
    const update = () =>
      document.documentElement.style.setProperty("--oc-toolbar-height", `${element.getBoundingClientRect().height}px`)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    onCleanup(() => {
      observer.disconnect()
      document.documentElement.style.removeProperty("--oc-toolbar-height")
    })
  })
  return (
    <footer ref={element} class="oc-toolbar" aria-label={language.t("user.toolbar.label")}>
      <div class="oc-toolbar-brand">
        <b aria-hidden="true">Dev</b>
        <span>OpenCode Dev</span>
      </div>
      {props.children}
    </footer>
  )
}
