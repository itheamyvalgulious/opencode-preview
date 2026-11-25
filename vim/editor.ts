// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * The vim editor surface for one text file inside a session panel.
 *
 * Rendered imperatively (createElement/setProp) so the plugin needs no JSX
 * transform. The textarea is the focus and drawing surface; every keypress is
 * routed through the `Vim` engine, which owns all editing behavior.
 */

import { createSignal, onCleanup } from "solid-js"
import { createElement, insert, setProp } from "@opentui/solid"
import type { InputRenderable, KeyEvent, PasteEvent } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid"
import { Vim } from "./engine.ts"
import { createVimBuffer } from "./buffer.ts"
import { createHighlighter } from "./highlight.ts"
import { keepFocus } from "./focus.ts"
import { createSyntax } from "./syntax.ts"
import type { VimStatus } from "./engine.ts"
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

const MODE_LABEL: Record<VimStatus["mode"], string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
  "visual-line": "V-LINE",
}

export type VimEditorProps = {
  context: Context
  /** Absolute path on the server's filesystem. */
  path: string
  /** Path shown to the user (usually relative to the session directory). */
  displayPath: string
  content: string
  filetype?: string
  bytes: number
  readOnly?: boolean
  onClose: () => void
  onSave: (text: string, target?: string) => Promise<void>
  onOpen: (path: string) => void
}

export function VimEditor(props: VimEditorProps): JSX.Element {
  const theme = props.context.theme
  const [status, setStatus] = createSignal<VimStatus>({
    mode: "normal",
    pending: "",
    message: "",
    line: 1,
    col: 1,
    dirty: false,
  })
  const [saving, setSaving] = createSignal(false)
  const [notice, setNotice] = createSignal("")

  const syntax = createSyntax(theme, props.context.renderer.nativeScene)

  const header = text({ fg: theme.text.base, wrapMode: "none" }, [""]) as unknown as { content: string }
  const headerRight = text({ fg: theme.text.muted, wrapMode: "none" }, [""]) as unknown as { content: string }
  const statusLeft = text({ fg: theme.text.muted, wrapMode: "none" }, [""]) as unknown as { content: string }
  const statusRight = text({ fg: theme.text.muted, wrapMode: "none" }, [""]) as unknown as { content: string }
  const prompt = text({ fg: theme.text.base, wrapMode: "none", height: 1 }, [""]) as unknown as { content: string }

  // `InputRenderable` (not `TextareaRenderable`) is deliberate: the host keys
  // every focused Textarea through its managed key layer, which consumes Enter,
  // arrows and backspace before the renderable sees them. The layer explicitly
  // excludes InputRenderable, and this editor only needs the EditBuffer surface
  // (all editing goes through it directly, not through the input's bindings).
  const area: InputRenderable = createElement("input") as InputRenderable
  setProp(area, "width", "100%")
  setProp(area, "flexGrow", 1)
  setProp(area, "minHeight", 0)
  setProp(area, "wrapMode", "none")
  setProp(area, "showCursor", true)
  setProp(area, "cursorStyle", { style: "block", blinking: false })
  setProp(area, "selectable", true)
  setProp(area, "height", "100%")
  setProp(area, "textColor", theme.text.base)
  setProp(area, "backgroundColor", theme.background.base)
  setProp(area, "focusedTextColor", theme.text.base)
  setProp(area, "focusedBackgroundColor", theme.background.base)
  setProp(area, "selectionBg", theme.background.action.primary.focused)
  setProp(area, "syntaxStyle", syntax)
  area.editBuffer.setText(props.content)

  const numbered = element(
    "line_number",
    { fg: theme.text.muted, minWidth: 4, paddingRight: 1, width: "100%", flexGrow: 1, minHeight: 0 },
    [area],
  )

  const root = element("box", { flexDirection: "column", width: "100%", flexGrow: 1, minHeight: 0 }, [
    element("box", { flexDirection: "row", justifyContent: "space-between", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, [
      header,
      headerRight,
    ]),
    element("box", { flexGrow: 1, minHeight: 0, paddingLeft: 1 }, [numbered]),
    element("box", { flexShrink: 0, paddingLeft: 1, paddingRight: 1 }, [prompt]),
    element(
      "box",
      {
        flexDirection: "row",
        justifyContent: "space-between",
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.background.raised.base,
      },
      [statusLeft, statusRight],
    ),
  ])

  const clipboard = (value: string) => {
    try {
      props.context.renderer.copyToClipboardOSC52(value)
    } catch {
      // OSC 52 is best-effort; unsupported terminals simply ignore it.
    }
  }

  const vim = new Vim(createVimBuffer(area.editBuffer, area.editorView, clipboard), {
    onChange: () => setStatus(vim.status()),
    onQuit: () => {
      if (vim.status().dirty && !props.readOnly) {
        setStatus({ ...vim.status(), message: "No write since last change (use :q!)" })
        return
      }
      props.onClose()
    },
    onWrite: async (target) => {
      if (props.readOnly) {
        setNotice("read-only buffer")
        setStatus(vim.status())
        return
      }
      setSaving(true)
      try {
        const next = target ? target : undefined
        await props.onSave(area.editBuffer.getText(), next)
        vim.setDirty(false)
        setNotice(next ? `written to ${next}` : "written")
      } catch (error) {
        setNotice(`write failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        setSaving(false)
        setStatus(vim.status())
      }
    },
    onEdit: async (target, force) => {
      if (vim.status().dirty && !force) {
        setNotice("unsaved changes (use :e! to discard)")
        setStatus(vim.status())
        return
      }
      const next = target ?? props.path
      const home = process.env.HOME
      const resolved = next.startsWith("~/") && home ? `${home}/${next.slice(2)}` : next
      props.onOpen(resolved)
    },
    onExCommand: (name) => {
      setNotice(`:${name} is not supported`)
      return true
    },
    name: () => props.displayPath,
  })
  vim.reset()

  const highlighter = createHighlighter({
    editBuffer: area.editBuffer,
    syntaxStyle: syntax,
    filetype: () => props.filetype,
    text: () => area.editBuffer.getText(),
  })
  highlighter.refresh()

  const render = () => {
    const current = status()
    const total = area.editBuffer.getLineCount()
    const cursor = area.editBuffer.getCursorPosition()
    const percent = total <= 1 ? "All" : `${Math.max(1, Math.round(((cursor.row + 1) / total) * 100))}%`
    header.content = `${current.dirty && !props.readOnly ? "● " : ""}${props.displayPath}`
    headerRight.content = `${formatBytes(props.bytes)}${props.readOnly ? " · read-only" : ""}`
    const promptText = current.prompt ? `${current.prompt.type}${current.prompt.text}` : ""
    prompt.content = promptText
    if (current.prompt) {
      statusLeft.content = `-- ${MODE_LABEL[current.mode]} --`
      statusRight.content = `${current.line},${current.col}  ${percent}`
      return
    }
    const message = notice() || current.message
    statusLeft.content = message
      ? `-- ${MODE_LABEL[current.mode]} --  ${message}`
      : `-- ${MODE_LABEL[current.mode]} --${saving() ? "  writing…" : ""}`
    statusRight.content = `${props.path.endsWith("/") ? "" : ""}${current.line},${current.col}  ${percent}${current.pending ? `  ${current.pending}` : ""}`
    header.content = `${current.dirty && !props.readOnly ? "● " : ""}${props.displayPath}`
  }

  const applyKey = (name: string, modifiers: { ctrl: boolean; meta: boolean; shift: boolean }) => {
    setNotice("")
    if (name === "c" && modifiers.ctrl) {
      props.onClose()
      return
    }
    if (name === "p" && modifiers.ctrl) {
      props.context.keymap.dispatch("command.palette.show")
      return
    }
    vim.handleKey({ name, ...modifiers })
    render()
  }

  // Claim input for the viewer: the host's base-mode textarea layer otherwise
  // consumes Enter/arrows/backspace before the vim engine sees them. The mode
  // is only active while this viewer owns the keyboard, so the prompt keeps
  // working when the user moves focus back to it.
  const focus = keepFocus({ context: props.context, root: () => root, target: () => area })
  const keymap = props.context.keymap as unknown as {
    mode: { push(mode: string, active?: () => boolean): () => void }
  }
  const popMode = keymap.mode.push("preview.vim", focus.owns)

  // Named keys are claimed at a high priority so host base-mode bindings
  // (arrows, paging) cannot swallow them before the input sees them.
  props.context.keymap.layer(() => ({
    mode: "preview.vim",
    priority: 100,
    commands: [
      "return",
      "backspace",
      "delete",
      "tab",
      "left",
      "right",
      "up",
      "down",
      "home",
      "end",
      "pageup",
      "pagedown",
    ].map((name) => ({
      bind: name,
      run: () => applyKey(name, { ctrl: false, meta: false, shift: false }),
    })),
  }))

  area.onKeyDown = (key: KeyEvent) => {
    // The engine owns every keypress; the input's own bindings must never run.
    key.preventDefault()
    key.stopPropagation()
    applyKey(key.name, { ctrl: key.ctrl, meta: key.meta, shift: key.shift })
  }

  area.onPaste = (event: PasteEvent) => {
    event.preventDefault()
    event.stopPropagation()
    vim.paste(new TextDecoder().decode(event.bytes))
    render()
  }
  area.onContentChange = () => {
    render()
    highlighter.refresh()
  }

  render()
  onCleanup(() => {
    popMode()
    focus.stop()
    highlighter.dispose()
    syntax.destroy?.()
  })

  return root as unknown as JSX.Element
}

