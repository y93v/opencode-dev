// DevCode FX runtime — cursor / spotlight / ripple / magnetic / trail layer
// for the animated themes. One singleton instance; toggled on/off when the
// theme picker switches between an animated kit and a static one.
//
// Everything is dependency-free DOM + rAF. Respects prefers-reduced-motion
// (returns a no-op dispose). The runtime attaches ONLY when the active theme
// is in ANIMATED_KITS inside devcode-theme-fab.tsx; static kits run with
// no cursor / trail / ripple overhead.

type CursorKind = "glow" | "ring" | "dot" | "block"

export type FxConfig = {
  readonly cursor?: CursorKind
  readonly hideNative?: boolean
  readonly magnetic?: string
  readonly magnetStrength?: number
  readonly tilt?: string
  readonly tiltMax?: number
  readonly spotlight?: string
  readonly edge?: string
  readonly ripple?: string
  readonly parallax?: boolean
  readonly trail?: boolean
  readonly trailColors?: readonly string[]
}

// Per-kit fx config. Deliberately NO per-element bindings (no magnetic,
// tilt, spotlight, ripple, edge targets). Attempts to attach those to
// the bottom-nav pills caused a cascade of layout bugs — the pills are
// fixed-positioned at precise `left-N` offsets and any per-pointer
// translate / border-glow mask / ripple-host overflow:hidden stacked
// them diagonally off the row, OR Tailwind's CSS optimizer merged the
// `html[data-fx]` prefix away and leaked styles to static themes. All
// animated kits now drive effects exclusively from the viewport layer:
// custom cursor (glow / ring / dot / block), screen-wide overlays
// (phosphor's scanlines, flicker), and the sparkle trail. Nothing
// reaches into the DOM to re-style individual elements, so the chrome
// is immune to the fx layer by construction.
export const KIT_FX: Readonly<Record<string, FxConfig>> = {
  // Parallax on: the ambient background's orbs/blobs/auras shift slightly
  // with the cursor via --px/--py set on <html>. Costs ~0 since the move
  // is a CSS variable + translate transition, no layout.
  frost: { cursor: "glow", parallax: true },
  obsidian: { cursor: "ring", hideNative: true },
  phosphor: { cursor: "block", hideNative: true },
  porcelain: { cursor: "dot", hideNative: true, parallax: true },
  prism: { cursor: "glow", parallax: true },
  vapor: { cursor: "dot", trail: true, trailColors: ["#ffd166", "#ff8a5c", "#ff4fa3", "#8f5cff"] },
}

type Dispose = () => void

export function initFx(cfg: FxConfig): Dispose {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined
  // Reduced motion: do nothing. Static CSS already zeros durations.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => undefined

  const html = document.documentElement
  const body = document.body
  const offs: Dispose[] = []
  const on = <K extends keyof HTMLElementEventMap>(
    t: EventTarget,
    ev: K | string,
    fn: EventListener,
    opt?: AddEventListenerOptions,
  ) => {
    t.addEventListener(ev, fn, opt)
    offs.push(() => t.removeEventListener(ev, fn, opt))
  }
  const $$ = (sel?: string) => (sel ? Array.from(document.querySelectorAll<HTMLElement>(sel)) : [])
  const HOT =
    "a,button,input,textarea,select,[role=button],[contenteditable=true],.fx-btn,.fx-pill,.fx-item"
  const bound = new WeakSet<HTMLElement>()
  let mx = -9999
  let my = -9999
  let frame = 0
  let alive = true

  function mark() {
    if (cfg.spotlight) $$(cfg.spotlight).forEach((el) => el.classList.add("fx-spot"))
    if (cfg.edge) $$(cfg.edge).forEach((el) => el.classList.add("fx-edge"))
    if (cfg.ripple) $$(cfg.ripple).forEach((el) => el.classList.add("fx-ripple-host"))
    if (cfg.magnetic) $$(cfg.magnetic).forEach(bindMagnet)
    if (cfg.tilt) $$(cfg.tilt).forEach(bindTilt)
  }

  function bindMagnet(el: HTMLElement) {
    if (bound.has(el)) return
    bound.add(el)
    el.classList.add("fx-magnet")
    const k = cfg.magnetStrength ?? 0.3
    on(el, "pointermove", ((e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      el.classList.add("is-pulling")
      el.style.translate = `${(e.clientX - r.left - r.width / 2) * k}px ${(e.clientY - r.top - r.height / 2) * k}px`
    }) as EventListener)
    on(el, "pointerleave", () => {
      el.classList.remove("is-pulling")
      el.style.translate = ""
    })
  }

  function bindTilt(el: HTMLElement) {
    if (bound.has(el)) return
    bound.add(el)
    const max = cfg.tiltMax ?? 5
    on(el, "pointermove", ((e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width - 0.5
      const y = (e.clientY - r.top) / r.height - 0.5
      el.style.transform = `perspective(1000px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg)`
    }) as EventListener)
    on(el, "pointerleave", () => {
      el.style.transform = ""
    })
  }

  function paint() {
    frame = 0
    for (const el of document.querySelectorAll<HTMLElement>(".fx-spot,.fx-edge")) {
      const r = el.getBoundingClientRect()
      el.style.setProperty("--mx", `${mx - r.left}px`)
      el.style.setProperty("--my", `${my - r.top}px`)
    }
    if (cfg.parallax) {
      html.style.setProperty("--px", ((mx / window.innerWidth) * 2 - 1).toFixed(3))
      html.style.setProperty("--py", ((my / window.innerHeight) * 2 - 1).toFixed(3))
    }
  }
  on(document, "pointermove", ((e: PointerEvent) => {
    mx = e.clientX
    my = e.clientY
    if (!frame) frame = requestAnimationFrame(paint)
    if (trail) trail.emit(mx, my)
  }) as EventListener, { passive: true })

  // Custom cursors
  const cursorEls: HTMLDivElement[] = []
  if (cfg.cursor) {
    const mk = (cls: string, parent: Element = body) => {
      const d = document.createElement("div")
      d.className = `fx-cursor ${cls}`
      d.setAttribute("aria-hidden", "true")
      parent.appendChild(d)
      cursorEls.push(d)
      return d
    }
    type Part = [HTMLDivElement, number]
    const kinds: Record<CursorKind, () => Part[]> = {
      ring: () => [[mk("fx-cursor-dot"), 1], [mk("fx-cursor-ring"), 0.18]],
      dot: () => [[mk("fx-cursor-solo"), 0.28]],
      glow: () => [[mk("fx-cursor-glow"), 0.07]],
      block: () => [[mk("fx-cursor-block"), 0.4]],
    }
    const parts = kinds[cfg.cursor]()
    if (cfg.hideNative) html.classList.add("fx-hide-cursor")
    const pos = parts.map(() => ({ x: mx, y: my }))
    const snap = cfg.cursor === "block"
    ;(function loop() {
      if (!alive) return
      parts.forEach(([el, ease], i) => {
        const p = pos[i]
        if (p.x < -9000) {
          p.x = mx
          p.y = my
        }
        p.x += (mx - p.x) * ease
        p.y += (my - p.y) * ease
        const x = snap ? Math.round(p.x / 10) * 10 : p.x
        const y = snap ? Math.round(p.y / 20) * 20 : p.y
        el.style.transform = `translate3d(${x}px,${y}px,0)`
      })
      requestAnimationFrame(loop)
    })()
    on(document, "pointerover", ((e: PointerEvent) => {
      const hot = !!(e.target as HTMLElement | null)?.closest?.(HOT)
      cursorEls.forEach((c) => c.classList.toggle("is-hot", hot))
    }) as EventListener)
    on(document, "pointerdown", () => cursorEls.forEach((c) => c.classList.add("is-down")))
    on(document, "pointerup", () => cursorEls.forEach((c) => c.classList.remove("is-down")))
    on(html, "pointerleave", () => cursorEls.forEach((c) => c.classList.add("is-gone")))
    on(html, "pointerenter", () => cursorEls.forEach((c) => c.classList.remove("is-gone")))
  }

  // Sparkle trail (canvas)
  type Trail = { emit(x: number, y: number): void; el: HTMLCanvasElement }
  let trail: Trail | null = null
  if (cfg.trail) {
    const cv = document.createElement("canvas")
    cv.className = "fx-trail"
    body.appendChild(cv)
    const ctx = cv.getContext("2d")!
    const ps: { x: number; y: number; vx: number; vy: number; r: number; a: number; va: number; life: number; c: string }[] = []
    let running = false
    let lx = 0
    let ly = 0
    const colors = cfg.trailColors ?? ["#fff"]
    const size = () => {
      const d = window.devicePixelRatio || 1
      cv.width = window.innerWidth * d
      cv.height = window.innerHeight * d
      ctx.setTransform(d, 0, 0, d, 0, 0)
    }
    size()
    on(window, "resize", size)
    const star = (x: number, y: number, r: number, a: number) => {
      ctx.beginPath()
      for (let i = 0; i < 8; i++) {
        const rr = i % 2 ? r * 0.35 : r
        const t = (i * Math.PI) / 4 + a
        ctx.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr)
      }
      ctx.closePath()
      ctx.fill()
    }
    const tick = () => {
      ctx.clearRect(0, 0, cv.width, cv.height)
      ctx.globalCompositeOperation = "lighter"
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]
        p.life -= 0.022
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.04
        p.a += p.va
        if (p.life <= 0) {
          ps.splice(i, 1)
          continue
        }
        ctx.globalAlpha = p.life
        ctx.fillStyle = p.c
        star(p.x, p.y, p.r * p.life, p.a)
      }
      if (ps.length && alive) requestAnimationFrame(tick)
      else running = false
    }
    trail = {
      emit(x, y) {
        const d = Math.hypot(x - lx, y - ly)
        if (d < 6) return
        lx = x
        ly = y
        for (let i = 0; i < 2; i++)
          ps.push({
            x,
            y,
            vx: (Math.random() - 0.5) * 1.6,
            vy: (Math.random() - 0.8) * 1.4,
            r: 3 + Math.random() * 4,
            a: Math.random() * 6,
            va: (Math.random() - 0.5) * 0.2,
            life: 1,
            c: colors[(Math.random() * colors.length) | 0],
          })
        if (ps.length > 160) ps.splice(0, ps.length - 160)
        if (!running) {
          running = true
          requestAnimationFrame(tick)
        }
      },
      el: cv,
    }
  }

  // Ripple
  if (cfg.ripple) {
    on(document, "pointerdown", ((e: PointerEvent) => {
      const host = (e.target as HTMLElement | null)?.closest?.(cfg.ripple!) as HTMLElement | null
      if (!host) return
      const r = host.getBoundingClientRect()
      const s = Math.max(r.width, r.height) * 2.2
      const dot = document.createElement("span")
      dot.className = "fx-ripple"
      Object.assign(dot.style, {
        width: `${s}px`,
        height: `${s}px`,
        left: `${e.clientX - r.left - s / 2}px`,
        top: `${e.clientY - r.top - s / 2}px`,
      })
      host.appendChild(dot)
      dot.addEventListener("animationend", () => dot.remove())
    }) as EventListener)
  }

  mark()
  const mo = new MutationObserver(() => {
    clearTimeout((mo as unknown as { t: number }).t)
    ;(mo as unknown as { t: number }).t = window.setTimeout(mark, 50)
  })
  mo.observe(body, { childList: true, subtree: true })

  return () => {
    alive = false
    mo.disconnect()
    offs.forEach((f) => f())
    cursorEls.forEach((c) => c.remove())
    trail?.el.remove()
    html.classList.remove("fx-hide-cursor")
  }
}
