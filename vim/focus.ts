// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import { CliRenderEvents, type Renderable } from "@opentui/core"
import { createSignal } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"

/**
 * Tracks whether a viewer owns keyboard input.
 *
 * `panel.focused` is not reliable enough on its own across host versions (a
 * freshly opened panel can keep `focused === false`), so the focus tree is used
 * instead:
 *
 *  - focus inside the viewer, or on one of its ancestors (the panel container)
 *    → the viewer owns input
 *  - focus anywhere else (prompt, dialog, another pane) → release
 *
 * Until focus lands strictly inside the viewer (`everOwned`), and for a few
 * seconds after mount, focus is claimed repeatedly: the host can refocus its
 * prompt right after a dialog (the /preview picker) closes, and losing that race
 * must not leave the viewer permanently without the keyboard.
 *
 * Keys themselves are handled by the viewer's own renderable handlers plus a
 * mode-scoped keymap layer; this only decides whether they should apply (the
 * layer's `enabled`/mode accessor uses `owns`).
 */

type Focusable = { focus(): void; isDestroyed?: boolean }

const isDescendant = (node: unknown, ancestor: unknown): boolean => {
  let current: unknown = node
  while (current && typeof current === "object") {
    if (current === ancestor) return true
    current = (current as { parent?: unknown }).parent
  }
  return false
}

export type FocusKeeper = {
  /** True while the viewer owns keyboard input. Reactive. */
  owns: () => boolean
  stop: () => void
}

export function keepFocus(options: {
  context: Context
  root: () => unknown
  target: () => Focusable | null | undefined
}): FocusKeeper {
  const { context } = options
  const [owns, setOwns] = createSignal(false)
  let disposed = false
  let everOwned = false
  const born = Date.now()

  /** Focus sits inside the viewer subtree (the target itself or a child). */
  const inside = () => {
    const focused = context.renderer.currentFocusedRenderable as Renderable | null
    if (!focused) return false
    return isDescendant(focused, options.root())
  }

  /** Focus inside the viewer or on one of its ancestors (the panel container). */
  const focusedInPanel = () => {
    const focused = context.renderer.currentFocusedRenderable as Renderable | null
    if (!focused) return false
    const root = options.root()
    return isDescendant(focused, root) || isDescendant(root, focused)
  }

  const apply = () => {
    if (disposed) return
    const target = options.target()
    if (!target || target.isDestroyed) return
    try {
      target.focus()
    } catch {
      // Layout may not be ready yet.
    }
  }

  // The host can refocus its own chrome just after the viewer mounts — most
  // visibly the prompt refocus that runs when a dialog (the /preview picker)
  // closes. Keep reclaiming during this short window so that race cannot leave
  // the viewer permanently without the keyboard. `everOwned` only counts
  // strict-inside focus: focus on the panel container alone is not enough to
  // deliver printable keys to onKeyDown, so it must not end the claim.
  const claiming = () => !everOwned || Date.now() - born < 4000

  if (inside()) everOwned = true
  if (focusedInPanel()) setOwns(true)

  const onFocus = () => {
    if (disposed) return
    if (inside()) everOwned = true
    if (focusedInPanel()) {
      setOwns(true)
      return
    }
    setOwns(false)
    if (claiming()) {
      setTimeout(() => {
        if (disposed || !claiming() || focusedInPanel()) return
        // Never steal a foreign dialog's keyboard during the grace window.
        if (context.keymap.mode.current() === "modal") return
        apply()
      }, 0)
    }
  }

  context.renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocus)

  const retry = [0, 80, 250, 600, 1200, 2000, 3200].map((delay) =>
    setTimeout(() => {
      if (disposed || inside()) return
      // A foreign modal dialog owns the keyboard; do not steal it. Focus inside
      // the viewer's own tree is exempt (its layers already won the mode).
      if (!focusedInPanel() && context.keymap.mode.current() === "modal") return
      apply()
      // focus() may not emit FOCUSED_RENDERABLE; reflect the result directly.
      if (inside()) {
        everOwned = true
        setOwns(true)
      }
    }, delay),
  )

  return {
    owns,
    stop() {
      disposed = true
      for (const timer of retry) clearTimeout(timer)
      context.renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocus)
    },
  }
}
