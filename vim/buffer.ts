// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import type { EditBuffer, EditorView } from "@opentui/core"
import type { Pos, VimBuffer } from "./engine.ts"

/**
 * Adapts an OpenTUI `EditBuffer`/`EditorView` pair to the engine's `VimBuffer`.
 * Cursor and range coordinates are logical (row, display-cell column), which is
 * exactly the buffer's `LogicalCursor` shape.
 */
export function createVimBuffer(
  editBuffer: EditBuffer,
  editorView: EditorView,
  writeClipboard?: (text: string) => void,
): VimBuffer {
  const viewportRows = () => {
    const viewport = editorView.getViewport()
    return Math.max(1, viewport?.height ?? 0)
  }
  const ensureVisible = () => {
    const viewport = editorView.getViewport()
    if (!viewport || viewport.width <= 0 || viewport.height <= 0) return
    // Re-applying the viewport with `moveCursor` scrolls just enough to reveal the cursor.
    editorView.setViewport(viewport.offsetX, viewport.offsetY, viewport.width, viewport.height, true)
  }
  return {
    text: () => editBuffer.getText(),
    lineCount: () => editBuffer.getLineCount(),
    cursor: () => {
      const cursor = editBuffer.getCursorPosition()
      return { row: cursor.row, col: cursor.col }
    },
    setCursor(pos: Pos) {
      editBuffer.setCursorToLineCol(pos.row, pos.col)
      ensureVisible()
    },
    measure: (text) => editBuffer.measureText(text),
    insert: (text) => editBuffer.insertText(text),
    newLine: () => editBuffer.newLine(),
    deleteCharAtCursor: () => editBuffer.deleteChar(),
    deleteBackward: () => editBuffer.deleteCharBackward(),
    deleteRange: (start: Pos, end: Pos) => editBuffer.deleteRange(start.row, start.col, end.row, end.col),
    undo: () => {
      editBuffer.undo()
    },
    redo: () => {
      editBuffer.redo()
    },
    select: (start: Pos, end: Pos) =>
      editorView.setSelection(editBuffer.positionToOffset(start.row, start.col), editBuffer.positionToOffset(end.row, end.col)),
    clearSelection: () => editorView.resetSelection(),
    viewportRows,
    viewportTop: () => editorView.getViewport()?.offsetY ?? 0,
    ...(writeClipboard ? { writeClipboard } : {}),
  }
}
