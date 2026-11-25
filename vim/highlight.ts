// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import { getTreeSitterClient, type EditBuffer, type SyntaxStyle } from "@opentui/core"

/**
 * Tree-sitter highlighting for the vim editor.
 *
 * `EditBuffer` renders highlights but does not parse; `highlightOnce` parses a
 * whole document off the renderer thread. Results are applied as per-line cell
 * ranges, so the editor scrolls and wraps correctly. Re-highlights are
 * debounced and stale requests are dropped.
 */

export type Highlighter = {
  /** Schedules a re-highlight of the current buffer content. */
  refresh(): void
  dispose(): void
}

const DEBOUNCE_MS = 250

export function createHighlighter(options: {
  editBuffer: EditBuffer
  syntaxStyle: SyntaxStyle
  filetype: () => string | undefined
  text: () => string
}): Highlighter {
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let disposed = false

  const resolveStyle = (scope: string): number | null => {
    const direct = options.syntaxStyle.getStyleId(scope)
    if (direct !== null && direct !== undefined) return direct
    const head = scope.split(".")[0]
    const parent = head ? options.syntaxStyle.getStyleId(head) : null
    return parent ?? null
  }

  const apply = (text: string, highlights: Array<[number, number, string, unknown?]>) => {
    const buffer = options.editBuffer
    buffer.clearAllHighlights()
    if (!text) return
    const lines = text.split("\n")
    // UTF-16 offset of each line start (tree-sitter reports UTF-16 code-unit ranges).
    const starts: number[] = [0]
    for (let row = 0; row < lines.length; row++) starts.push(starts[row]! + lines[row]!.length + 1)
    const cellWidth = (row: number, index: number) => buffer.measureText(lines[row]!.slice(0, index))

    for (const [start, end, scope] of highlights) {
      const styleId = resolveStyle(scope)
      if (styleId === null || styleId < 0) continue
      let row = 0
      // Find the line containing `start`.
      while (row + 1 < lines.length && starts[row + 1]! <= start) row++
      let offset = start
      while (offset < end && row < lines.length) {
        const line = lines[row]!
        const lineStart = starts[row]!
        const lineEnd = lineStart + line.length
        if (offset > lineEnd) {
          row++
          continue
        }
        const from = Math.max(0, offset - lineStart)
        const to = Math.min(line.length, end - lineStart)
        if (to > from) {
          const cellStart = cellWidth(row, from)
          const cellEnd = cellWidth(row, to)
          buffer.addHighlight(row, { start: cellStart, end: cellEnd, styleId })
        }
        row++
        offset = lineStart + line.length + 1
      }
    }
  }

  const run = async () => {
    const filetype = options.filetype()
    if (!filetype || disposed) return
    const generationAtRequest = ++generation
    const text = options.text()
    try {
      const result = await getTreeSitterClient().highlightOnce(text, filetype)
      if (disposed || generationAtRequest !== generation) return
      if (result.highlights) apply(text, result.highlights)
    } catch {
      // Highlighting is best-effort: an unavailable parser keeps plain text.
    }
  }

  return {
    refresh() {
      if (disposed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void run()
      }, DEBOUNCE_MS)
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
