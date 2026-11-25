// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { PdfViewer } from "../viewer/media.ts"
import { isPdfSupported } from "../util/pdf.ts"

const color = (value: number) => RGBA.fromInts(value, value, value, 255)
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
  background: { base: color(10), raised: { base: color(20) }, action: { primary: { focused: color(40) } } },
} as never

const stub = (renderer: unknown) =>
  ({
    theme,
    themeMode: "dark",
    renderer,
    keymap: { dispatch() {}, layer() {}, mode: { push: () => () => {}, current: () => "base" } },
    options: {},
    ui: {},
    storage: {},
  }) as never

type Node = {
  constructor: { name: string }
  source?: unknown
  getLayout?: () => { width: number; height: number }
  getChildren?: () => Node[]
}

const collect = (node: Node, found: Node[] = []): Node[] => {
  if (/ImageRenderable/.test(node.constructor?.name ?? "")) found.push(node)
  for (const child of node.getChildren?.() ?? []) collect(child, found)
  return found
}

const settle = async (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

test("PDF pages rasterize into an image node and respond to keys", { skip: !isPdfSupported() && "no PDF rasterizer" }, async () => {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/two-pages.pdf", import.meta.url))))
  const app = await createTestRenderer({ width: 80, height: 30 })
  const events: string[] = []
  try {
    await render(
      () =>
        PdfViewer({
          context: stub(app.renderer),
          bytes,
          title: "two-pages.pdf",
          pageCount: 2,
          onClose: () => events.push("close"),
          onFullscreen: () => events.push("fullscreen"),
        }),
      app.renderer,
    )
    // Rasterizing both pages takes a moment on a cold cache.
    for (let attempt = 0; attempt < 100; attempt++) {
      await settle()
      await app.flush()
      if (/page 1\/2/.test(app.captureCharFrame()) && collect(app.renderer.root as unknown as Node).some((node) => node.source)) break
    }

    const frame = app.captureCharFrame()
    assert.match(frame, /page 1\/2/)
    assert.doesNotMatch(frame, /rendering/)
    const images = collect(app.renderer.root as unknown as Node)
    assert.equal(images.length, 1, "the PDF page image must be mounted")
    assert.ok(images[0]!.source, "the image must carry the rendered PNG bytes")
    const layout = images[0]!.getLayout?.()
    assert.ok((layout?.width ?? 0) > 0 && (layout?.height ?? 0) > 0, "the image must have a non-zero layout")

    app.mockInput.pressKey("j")
    for (let attempt = 0; attempt < 100; attempt++) {
      await settle()
      await app.flush()
      if (/page 2\/2/.test(app.captureCharFrame())) break
    }
    assert.match(app.captureCharFrame(), /page 2\/2/)
    assert.equal(events.length, 0)

    app.mockInput.pressKey("f")
    await app.flush()
    assert.deepEqual(events, ["fullscreen"])

    app.mockInput.pressKey("q")
    await app.flush()
    assert.deepEqual(events, ["fullscreen", "close"])
  } finally {
    await app.dispose()
  }
})
