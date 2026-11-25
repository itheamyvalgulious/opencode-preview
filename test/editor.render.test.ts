// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict"
import { test } from "node:test"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { VimEditor } from "../vim/editor.ts"

const color = (value: number) => RGBA.fromInts(value, value, value, 255)

/** Only the theme tokens the editor and syntax builder read. */
const theme = {
  text: {
    base: color(220),
    muted: color(140),
    feedback: {
      error: { base: color(200) },
      warning: { base: color(180) },
      info: { base: color(160) },
      success: { base: color(150) },
    },
  },
  background: {
    base: color(10),
    raised: { base: color(20) },
    action: { primary: { focused: color(40) } },
  },
  syntax: {
    comment: color(120),
    string: color(110),
    number: color(130),
    keyword: color(90),
    type: color(100),
    function: color(105),
    operator: color(115),
    punctuation: color(125),
    variable: color(135),
  },
  markdown: {
    heading: color(95),
    strong: color(96),
    emphasis: color(97),
    listItem: color(98),
    blockQuote: color(99),
    code: color(101),
    link: color(102),
    linkText: color(103),
  },
} as never

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

test("renders a text file and routes vim keys through a real edit buffer", async () => {
  const app = await createTestRenderer({ width: 70, height: 16 })
  const saved: string[] = []
  let closed = false
  const context = {
    theme,
    themeMode: "dark",
    renderer: app.renderer,
    keymap: { dispatch() {}, layer: () => {}, mode: { push: () => () => {}, current: () => "base" } },
    options: {},
    ui: {},
    storage: {},
  } as never

  try {
    await render(
      () =>
        VimEditor({
          context,
          path: "/work/notes.txt",
          displayPath: "notes.txt",
          content: "alpha\nbeta\ngamma",
          filetype: "text",
          bytes: 16,
          onClose: () => {
            closed = true
          },
          onOpen: () => undefined,
          onSave: async (text) => {
            saved.push(text)
          },
        }),
      app.renderer,
    )
    await tick()
    await app.flush()

    const first = app.captureCharFrame()
    assert.match(first, /notes\.txt/)
    assert.match(first, /NORMAL/)
    assert.match(first, /alpha/)

    // j j moves to the last line; dd removes it.
    app.mockInput.pressKey("j")
    app.mockInput.pressKey("j")
    app.mockInput.pressKey("d")
    app.mockInput.pressKey("d")
    await app.flush()
    assert.doesNotMatch(app.captureCharFrame(), /gamma/)

    // i inserts, escape returns to normal. A lone ESC is resolved by the input
    // parser after a short timeout, exactly like a real terminal.
    app.mockInput.pressKey("i")
    app.mockInput.typeText("xyz")
    app.mockInput.pressEscape()
    await tick(80)
    await app.flush()
    assert.match(app.captureCharFrame(), /NORMAL/)

    // :w calls onSave with the edited text.
    app.mockInput.pressKey(":")
    app.mockInput.typeText("w")
    app.mockInput.pressEnter()
    await tick()
    await app.flush()

    assert.equal(saved.length, 1)
    assert.match(saved[0]!, /xyz/)
    assert.match(saved[0]!, /beta/)
    assert.doesNotMatch(saved[0]!, /gamma/)
    assert.equal(closed, false)
  } finally {
    await app.dispose()
  }
})

test("q in normal mode closes the viewer", async () => {
  const app = await createTestRenderer({ width: 60, height: 12 })
  let closed = false
  const context = {
    theme,
    themeMode: "dark",
    renderer: app.renderer,
    keymap: { dispatch() {}, layer: () => {}, mode: { push: () => () => {}, current: () => "base" } },
    options: {},
    ui: {},
    storage: {},
  } as never
  try {
    await render(
      () =>
        VimEditor({
          context,
          path: "/work/a.txt",
          displayPath: "a.txt",
          content: "one",
          filetype: "text",
          bytes: 3,
          onClose: () => {
            closed = true
          },
          onOpen: () => undefined,
          onSave: async () => undefined,
        }),
      app.renderer,
    )
    await tick()
    await app.flush()
    app.mockInput.pressKey("q")
    await app.flush()
    assert.equal(closed, true)
  } finally {
    await app.dispose()
  }
})
