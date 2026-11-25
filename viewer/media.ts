// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Image and PDF viewers.
 *
 * Both render with OpenTUI's `<image>` element, which uses the terminal's native
 * graphics protocol (kitty/sixel) or a block fallback. PDFs are rasterized to
 * PNG first (util/pdf.ts).
 */

import { createEffect, createSignal, onCleanup } from "solid-js"
import { keepFocus } from "../vim/focus.ts"
import { createElement, insert, setProp } from "@opentui/solid"
import type { KeyEvent } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { renderPdfPage } from "../util/pdf.ts"
import { formatBytes } from "../util/paths.ts"

type Node = ReturnType<typeof createElement>

const element = (tag: string, props: Record<string, unknown>, children: unknown[] = []): Node => {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value)
  }
  insert(node, children as never)
  return node
}

const text = (props: Record<string, unknown>, children: string[] = []) => element("text", props, children)

type FrameOptions = {
  title: string
  subtitle: string
  hint: string
  onKey: (key: KeyEvent) => void
}

type Frame = {
  root: Node
  body: Node
  setSubtitle(value: string): void
  setHint(value: string): void
}

function frame(context: Context, options: FrameOptions): Frame {
  const theme = context.theme
  const title = text({ fg: theme.text.base, wrapMode: "none" }, [options.title])
  const subtitle = text({ fg: theme.text.muted, wrapMode: "none" }, [options.subtitle]) as unknown as {
    content: string
  }
  const hint = text({ fg: theme.text.muted, wrapMode: "none" }, [options.hint]) as unknown as { content: string }
  const body = element("box", { flexGrow: 1, minHeight: 0, alignItems: "center", justifyContent: "center" })
  const input = element("box", { flexGrow: 1, minHeight: 0, focusable: true })
  setProp(input, "onKeyDown", (key: KeyEvent) => {
    key.preventDefault()
    key.stopPropagation()
    options.onKey(key)
  })
  // A click anywhere on the preview claims the keyboard — without this, clicks
  // leave focus on the prompt and the viewer's shortcuts look dead.
  const claim = () => {
    try {
      ;(input as unknown as { focus(): void }).focus()
    } catch {
      // Layout may not be ready yet.
    }
  }
  setProp(input, "onMouseDown", claim)
  insert(input, [body])

  const focus = keepFocus({
    context,
    root: () => input,
    target: () => input as unknown as { focus(): void; isDestroyed?: boolean },
  })
  const keymap = context.keymap as unknown as {
    mode: { push(mode: string, active?: () => boolean): () => void }
    layer(factory: () => unknown): void
  }
  const popMode = keymap.mode.push("preview.viewer", focus.owns)
  // Named keys (arrows, paging, space, Escape) are bound by host base-mode
  // commands and would never reach onKeyDown; claim them while the viewer owns
  // the keyboard. Printable keys are bound too: focus can legally rest on the
  // panel container (an ancestor of this input), which owns() reports but which
  // never forwards keydown to the input — without the layer binds those keys
  // would hit unbound base-mode handlers and look dead.
  //
  // Each entry is [bind, name]: the bind catches the physical key (shifted
  // letters arrive either as name "G" or as "g"+shift depending on the input
  // path, so both spellings are bound) and `name` is the canonical event name
  // passed to onKey.
  const keys: Array<[bind: string, name: string, ctrl?: boolean]> = [
    ["up", "up"],
    ["down", "down"],
    ["left", "left"],
    ["right", "right"],
    ["pageup", "pageup"],
    ["pagedown", "pagedown"],
    ["home", "home"],
    ["end", "end"],
    ["space", "space"],
    ["return", "return"],
    ["escape", "escape"],
    ["ctrl+c", "c", true],
    ["q", "q"],
    ["j", "j"],
    ["k", "k"],
    ["g", "g"],
    ["G", "G"],
    ["shift+g", "G"],
    ["z", "z"],
    ["f", "f"],
    ["+", "+"],
    ["shift+=", "+"],
    ["=", "="],
    ["-", "-"],
  ]
  keymap.layer(() => ({
    mode: "preview.viewer",
    priority: 100,
    commands: keys.map(([bind, name, ctrl]) => ({
      bind,
      run: () => {
        options.onKey({
          name,
          ctrl: ctrl === true,
          meta: false,
          shift: false,
          preventDefault() {},
          stopPropagation() {},
        } as unknown as KeyEvent)
      },
    })),
  }))
  onCleanup(() => {
    popMode()
    focus.stop()
  })

  const root = element(
    "box",
    { flexDirection: "column", width: "100%", flexGrow: 1, minHeight: 0, onMouseDown: claim },
    [
      element(
        "box",
        { flexDirection: "row", justifyContent: "space-between", flexShrink: 0, paddingLeft: 1, paddingRight: 1 },
        [title, subtitle],
      ),
      element("box", { flexGrow: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 }, [input]),
      element("box", { flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, [hint]),
    ],
  )
  return {
    root,
    body,
    setSubtitle: (value) => {
      subtitle.content = value
    },
    setHint: (value) => {
      hint.content = value
    },
  }
}

export type LoadingViewProps = {
  context: Context
  label: string
  since: number
  onClose: () => void
}

/**
 * The placeholder shown while a file is being read and detected.
 *
 * Reading can take seconds on cloud/FUSE mounts, so this surface is focusable
 * too: the viewer keeps owning the keyboard and `q`/`Escape` can back out
 * instead of the panel looking stuck.
 */
export function LoadingView(props: LoadingViewProps): JSX.Element {
  const [now, setNow] = createSignal(Date.now())
  const ticker = setInterval(() => setNow(Date.now()), 500)
  const theme = props.context.theme
  const message = text({ fg: theme.text.muted, paddingLeft: 1, wrapMode: "none" }, [""]) as unknown as {
    content: string
  }

  const view = frame(props.context, {
    title: props.label,
    subtitle: "",
    hint: "q cancel",
    onKey: (key) => {
      if (key.name === "q" || key.name === "escape" || (key.name === "c" && key.ctrl)) props.onClose()
    },
  })
  const render = () => {
    const seconds = Math.max(0, Math.round((now() - props.since) / 1000))
    message.content = `loading…${seconds > 0 ? ` ${seconds}s` : ""} (network/cloud mounts can be slow)`
  }
  insert(view.body, [message])
  render()
  onCleanup(() => clearInterval(ticker))
  return view.root as unknown as JSX.Element
}

export type ImageViewerProps = {
  context: Context
  bytes: Uint8Array
  title: string
  subtitle: string
  onClose: () => void
  onFullscreen: () => void
}

export function ImageViewer(props: ImageViewerProps): JSX.Element {
  const [failed, setFailed] = createSignal(false)
  const view = frame(props.context, {
    title: props.title,
    subtitle: props.subtitle,
    hint: "q close · f fullscreen",
    onKey: (key) => {
      if (key.name === "q" || key.name === "escape" || (key.name === "c" && key.ctrl)) return props.onClose()
      if (key.name === "f") return props.onFullscreen()
    },
  })
  insert(view.body, [
    element("image", {
      // Pass the encoded bytes through: OpenTUI can transmit PNG as-is, while a
      // decoded NativeImage would upload raw RGBA and multiply the traffic.
      source: props.bytes,
      fit: "fit",
      protocol: "auto",
      width: "100%",
      height: "100%",
      onError: () => setFailed(true),
    }),
  ])
  createEffect(() => {
    if (failed()) {
      view.setSubtitle("could not decode image")
      view.setHint("q close")
    }
  })
  return view.root as unknown as JSX.Element
}

export type PdfViewerProps = {
  context: Context
  bytes: Uint8Array
  title: string
  pageCount?: number
  onClose: () => void
  onFullscreen: () => void
}

// A page rendered at roughly 1.5 pixels per terminal row already looks sharp;
// anything more only inflates the graphics-protocol upload.
const ZOOM_STEPS = [50, 60, 72, 96, 120, 150, 200, 260]

function defaultZoom(rows: number): number {
  const target = Math.max(50, Math.min(110, Math.round(rows * 1.5)))
  let best = 0
  for (let index = 0; index < ZOOM_STEPS.length; index++) {
    if (Math.abs(ZOOM_STEPS[index]! - target) < Math.abs(ZOOM_STEPS[best]! - target)) best = index
  }
  return best
}

export function PdfViewer(props: PdfViewerProps): JSX.Element {
  const [page, setPage] = createSignal(1)
  const [zoom, setZoom] = createSignal(defaultZoom(props.context.renderer.height ?? 40))
  const [total] = createSignal(props.pageCount)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(true)
  let generation = 0
  // The image node is created here, inside the component's renderer owner:
  // `createElement` cannot run from an async callback (it throws "No renderer
  // found"), so later pages only replace its `source`.
  const image: Node | undefined = element("image", {
    fit: "fit",
    protocol: "auto",
    width: "100%",
    height: "100%",
  })
  const placeholder: Node | undefined = text({ fg: props.context.theme.text.muted }, ["rendering…"])

  const view = frame(props.context, {
    title: props.title,
    subtitle: "",
    hint: "j/k pages · +/- zoom · f fullscreen · q close",
    onKey: (key) => {
      if (key.name === "q" || key.name === "escape" || (key.name === "c" && key.ctrl)) return props.onClose()
      if (key.name === "f") return props.onFullscreen()
      if (key.name === "j" || key.name === "down" || key.name === "space" || key.name === "pagedown") return turn(1)
      if (key.name === "k" || key.name === "up" || key.name === "pageup") return turn(-1)
      if (key.name === "g" || key.name === "home") return go(1)
      if (key.name === "G" || key.name === "end") return go(total() ?? page())
      if (key.name === "+" || key.name === "=" || key.name === "z") return zoomBy(1)
      if (key.name === "-") return zoomBy(-1)
    },
  })
  // Both children are mounted up front. Later updates stay property-level —
  // `source` on the image node, `content` on the placeholder — so the mounted
  // subtree shape never changes after construction.
  insert(view.body, [placeholder, image])

  let startedAt = 0
  let elapsed = 0
  let phase = ""
  const describe = () => {
    const pages = total() ? `${page()}/${total()}` : `${page()}`
    const base = `${formatBytes(props.bytes.length)} · page ${pages} · ${ZOOM_STEPS[zoom()]} dpi`
    if (error()) {
      view.setSubtitle(`${base} · ${error()}`)
      return
    }
    if (!busy()) {
      view.setSubtitle(elapsed > 0 ? `${base} · rendered in ${(elapsed / 1000).toFixed(1)}s` : base)
      return
    }
    const seconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0
    view.setSubtitle(`${base} · rendering${phase ? ` [${phase}]` : ""}${seconds > 0 ? ` ${seconds}s` : "…"}`)
  }

  const load = () => {
    const token = ++generation
    startedAt = Date.now()
    elapsed = 0
    phase = ""
    setBusy(true)
    // Refresh the "rendering Ns" counter so a stalled rasterizer is visible.
    const ticker = setInterval(() => {
      if (token !== generation || !busy()) {
        clearInterval(ticker)
        return
      }
      describe()
    }, 1000)
    if (typeof ticker === "object") ticker.unref?.()
    setError("")
    describe()
    renderPdfPage(props.bytes, page(), ZOOM_STEPS[zoom()]!, (stage) => {
      phase = stage
      describe()
    }).then(
      (png) => {
        if (token !== generation) return
        elapsed = Date.now() - startedAt
        setBusy(false)
        describe()
        if (png === undefined) return
        setupImage(png)
      },
      (reason: unknown) => {
        if (token !== generation) return
        setBusy(false)
        setError(reason instanceof Error ? reason.message : String(reason))
        describe()
      },
    )
  }

  const setupImage = (png: Uint8Array) => {
    // Hide the "rendering…" text through a property write — never a remove.
    ;(placeholder as unknown as { content: string }).content = ""
    setProp(image, "source", png)
  }

  const turn = (delta: number) => {
    const next = page() + delta
    if (next < 1) return
    const limit = total()
    if (limit && next > limit) return
    if (!limit && delta > 0) {
      // Unknown page count: probe the next page before moving.
      renderPdfPage(props.bytes, next, ZOOM_STEPS[zoom()]!).then(
        () => {
          setPage(next)
          load()
        },
        () => {
          setError("last page")
          describe()
        },
      )
      return
    }
    if (!limit && delta < 0) {
      setPage(next)
      load()
      return
    }
    setPage(next)
    load()
  }

  const go = (target: number) => {
    const next = Math.max(1, total() ? Math.min(target, total()!) : target)
    if (next === page()) return
    setPage(next)
    load()
  }

  const zoomBy = (delta: number) => {
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, zoom() + delta))
    if (next === zoom()) return
    setZoom(next)
    load()
  }

  load()
  describe()

  onCleanup(() => {
    generation++
  })
  return view.root as unknown as JSX.Element
}
