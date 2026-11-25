// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * A small, dependency-free vim engine for the OpenCode TUI.
 *
 * The engine owns every keystroke while a viewer is focused; the textarea is
 * only a rendering and focus surface. Documents are reached through
 * `VimBuffer`, so the engine is unit-testable without a renderer.
 *
 * Coordinates are logical: zero-based row and zero-based display-cell column.
 */

export type Pos = { row: number; col: number }

export interface VimBuffer {
  text(): string
  /** Logical line count (>= 1). */
  lineCount(): number
  cursor(): Pos
  setCursor(pos: Pos): void
  /** Display width of `text` in cells (a newline counts 1). */
  measure(text: string): number
  insert(text: string): void
  newLine(): void
  deleteCharAtCursor(): void
  deleteBackward(): void
  /** Delete [start, end) in logical coordinates. */
  deleteRange(start: Pos, end: Pos): void
  undo(): void
  redo(): void
  select(start: Pos, end: Pos): void
  clearSelection(): void
  viewportRows(): number
  viewportTop(): number
  writeClipboard?(text: string): void
}

export type VimMode = "normal" | "insert" | "visual" | "visual-line"

export type VimPrompt = { type: ":" | "/" | "?"; text: string }

export type VimStatus = {
  mode: VimMode
  pending: string
  message: string
  line: number
  col: number
  dirty: boolean
  prompt?: VimPrompt
}

export type VimKey = {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export type VimCallbacks = {
  onChange?: () => void
  onQuit?: (force: boolean) => void
  onWrite?: (path: string | undefined) => void | Promise<void>
  onEdit?: (path: string | undefined, force: boolean) => void | Promise<void>
  /** Returns true when the host handled the command. */
  onExCommand?: (name: string, args: string) => boolean
  name?: () => string
}

type Range = { start: Pos; end: Pos; linewise: boolean }

const isPrintableName = (name: string) => [...name].length === 1

const charOf = (key: VimKey): string | undefined => {
  if (key.ctrl || key.meta) return undefined
  if (key.name === "space") return " "
  // Terminals deliver capital letters as lowercase + shift (`G` → g/shift).
  if (/^[a-z]$/.test(key.name)) return key.shift ? key.name.toUpperCase() : key.name
  if (isPrintableName(key.name)) return key.name
  return undefined
}

const wordChar = (ch: string | undefined) => ch !== undefined && (/[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127)
const spaceChar = (ch: string | undefined) => ch === undefined || /\s/.test(ch)

export class Vim {
  private mode: VimMode = "normal"
  private count = 0
  private operator: "d" | "y" | "c" | ">" | "<" | undefined
  private gPrefix = false
  private awaitReplace = false
  private awaitFind: "f" | "t" | "F" | "T" | undefined
  private lastFind: { kind: "f" | "t" | "F" | "T"; ch: string } | undefined
  private awaitMark: "m" | "`" | "'" | undefined
  private awaitRegister = false
  private pendingRegister: string | undefined
  private marks = new Map<string, Pos>()
  private register = ""
  private registerLinewise = false
  private namedRegisters = new Map<string, { text: string; linewise: boolean }>()
  private prompt: VimPrompt | undefined
  private lastSearch: { pattern: string; forward: boolean } | undefined
  private visualAnchor: Pos | undefined
  private message = ""
  private dirty = false
  private linesCache: string[] | undefined
  private textCache: string | undefined
  private recording: string[] | undefined
  private lastChange: { type: "keys"; keys: string[] } | { type: "insert"; entry: string; keys: string[] } | undefined
  private changedSinceSnapshot = false
  private replaying = false
  private insertEntry = "i"
  private insertKeys: string[] = []

  private readonly buffer: VimBuffer
  private readonly callbacks: VimCallbacks

  constructor(buffer: VimBuffer, callbacks: VimCallbacks = {}) {
    this.buffer = buffer
    this.callbacks = callbacks
  }

  // ── Public ──────────────────────────────────────────────────────────────

  getMode() {
    return this.mode
  }

  setDirty(value: boolean) {
    this.dirty = value
  }

  /** Mark the current buffer content clean (after load/save). */
  reset() {
    this.mode = "normal"
    this.count = 0
    this.operator = undefined
    this.gPrefix = false
    this.prompt = undefined
    this.visualAnchor = undefined
    this.message = ""
    this.dirty = false
    this.invalidate()
    this.buffer.clearSelection()
    this.callbacks.onChange?.()
  }

  status(): VimStatus {
    const { row, col } = this.buffer.cursor()
    return {
      mode: this.mode,
      pending:
        (this.count ? String(this.count) : "") +
        (this.operator ?? "") +
        (this.gPrefix ? "g" : "") +
        (this.pendingRegister ? `"${this.pendingRegister}` : ""),
      message: this.message,
      line: row + 1,
      col: col + 1,
      dirty: this.dirty,
      ...(this.prompt ? { prompt: { ...this.prompt } } : {}),
    }
  }

  handleKey(key: VimKey): true {
    if (!key.name) return true
    if (["shift", "control", "alt", "super", "release"].includes(key.name)) return true

    if (this.prompt) {
      this.promptKey(key)
      this.changed()
      return true
    }

    if (!this.recording && !this.replaying) this.recording = []
    if (this.recording && !this.replaying) this.record(key)

    if (this.awaitReplace) {
      this.awaitReplace = false
      const ch = charOf(key)
      if (ch) this.replaceChar(ch, Math.max(1, this.count))
      this.count = 0
      this.changed()
      return true
    }
    if (this.awaitFind) {
      const kind = this.awaitFind
      this.awaitFind = undefined
      const ch = charOf(key)
      if (ch) {
        this.lastFind = { kind, ch }
        this.findChar(kind, ch, Math.max(1, this.count))
      }
      this.count = 0
      this.changed()
      return true
    }
    if (this.awaitMark) {
      const kind = this.awaitMark
      this.awaitMark = undefined
      const ch = charOf(key)
      if (ch && /^[a-z]$/.test(ch)) {
        if (kind === "m") this.marks.set(ch, this.buffer.cursor())
        else {
          const mark = this.marks.get(ch)
          if (mark) this.buffer.setCursor(mark)
          this.changed()
        }
      }
      return true
    }
    if (this.awaitRegister) {
      this.awaitRegister = false
      const ch = charOf(key)
      this.pendingRegister = ch && /^[a-z"+*]$/.test(ch) ? ch : undefined
      this.changed()
      return true
    }

    return this.mode === "insert" ? this.insertKey(key) : this.finishNormalKey(key)
  }

  private finishNormalKey(key: VimKey): true {
    const result = this.normalKey(key)
    this.settleChange()
    return result
  }
  paste(text: string) {
    const normalized = text.replace(/\r\n?/g, "\n")
    if (this.prompt) {
      this.prompt.text += normalized.replace(/\s+/g, " ")
      this.changed()
      return
    }
    if (this.mode === "insert") {
      this.buffer.insert(normalized)
      this.markDirty()
      this.changed()
      return
    }
    const cur = this.buffer.cursor()
    const line = this.line(cur.row)
    this.buffer.setCursor({ row: cur.row, col: Math.min(cur.col + 1, this.cellsOf(line).at(-1) ?? 0) })
    this.buffer.insert(normalized)
    this.markDirty()
    this.changed()
  }

  // ── Document helpers ────────────────────────────────────────────────────

  private lines(): string[] {
    const text = this.buffer.text()
    if (!this.linesCache || text !== this.textCache) {
      this.textCache = text
      this.linesCache = text.split("\n")
    }
    return this.linesCache
  }

  private line(row: number): string {
    return this.lines()[row] ?? ""
  }

  /** Cell offsets for every UTF-16 index in `line`, plus the end. */
  private cellsOf(line: string): number[] {
    const out: number[] = []
    out[0] = 0
    let cells = 0
    let index = 0
    for (const ch of line) {
      cells += Math.max(1, this.buffer.measure(ch))
      index += ch.length
      out[index] = cells
    }
    out[line.length] = cells
    return out
  }

  private lineLength(row: number) {
    return this.cellsOf(this.line(row)).at(-1) ?? 0
  }

  private indexAt(row: number, col: number) {
    const cells = this.cellsOf(this.line(row))
    let best = 0
    for (let i = 0; i < cells.length; i++) {
      const at = cells[i]
      if (at === undefined) continue
      if (at <= col) best = i
      else break
    }
    return best
  }

  private cellAt(row: number, index: number) {
    const cells = this.cellsOf(this.line(row))
    return cells[Math.min(index, cells.length - 1)] ?? 0
  }

  private cursor(): Pos {
    return this.buffer.cursor()
  }

  private moveTo(pos: Pos, allowEnd = false) {
    const row = Math.max(0, Math.min(this.buffer.lineCount() - 1, pos.row))
    const max = allowEnd ? this.lineLength(row) : Math.max(0, this.lineLength(row) - 1)
    this.buffer.setCursor({ row, col: Math.max(0, Math.min(pos.col, max)) })
  }

  private rangeText(start: Pos, end: Pos): string {
    if (start.row === end.row) return this.line(start.row).slice(this.indexAt(start.row, start.col), this.indexAt(start.row, end.col))
    const parts = [this.line(start.row).slice(this.indexAt(start.row, start.col))]
    for (let row = start.row + 1; row < end.row; row++) parts.push(this.line(row))
    parts.push(this.line(end.row).slice(0, this.indexAt(end.row, end.col)))
    return parts.join("\n")
  }

  private invalidate() {
    this.linesCache = undefined
    this.textCache = undefined
  }

  private changed() {
    this.callbacks.onChange?.()
  }

  private markDirty() {
    this.dirty = true
    this.changedSinceSnapshot = true
  }

  private finishEdit(insert = false) {
    this.invalidate()
    if (!insert) this.moveTo(this.cursor())
    this.markDirty()
    this.changed()
  }

  /** Records the pending change for `.` when the command is complete. */
  private settleChange() {
    if (
      this.changedSinceSnapshot &&
      this.mode === "normal" &&
      !this.operator &&
      !this.count &&
      !this.gPrefix &&
      !this.awaitFind &&
      !this.awaitMark &&
      !this.awaitReplace &&
      !this.awaitRegister
    ) {
      if (this.recording && this.recording.length > 0) this.lastChange = { type: "keys", keys: [...this.recording] }
      this.recording = []
      this.changedSinceSnapshot = false
    } else if (!this.changedSinceSnapshot && this.mode === "normal" && !this.operator && !this.count) {
      // Pure motions/prefixes are not part of the repeatable change.
      this.recording = []
    }
  }

  private resetPending() {
    this.count = 0
    this.operator = undefined
    this.gPrefix = false
    this.pendingRegister = undefined
  }

  // ── Prompt ──────────────────────────────────────────────────────────────

  private startPrompt(type: ":" | "/" | "?") {
    this.prompt = { type, text: "" }
    this.resetPending()
    this.message = ""
    this.changed()
  }

  private promptKey(key: VimKey) {
    const prompt = this.prompt!
    if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
      this.prompt = undefined
      this.message = ""
      return
    }
    if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
      const text = prompt.text
      this.prompt = undefined
      if (prompt.type === ":") this.ex(text)
      else this.search(text, prompt.type === "/", true)
      return
    }
    if (key.name === "backspace") {
      if (!prompt.text) this.prompt = undefined
      else prompt.text = [...prompt.text].slice(0, -1).join("")
      return
    }
    const ch = charOf(key)
    if (ch) prompt.text += ch
  }

  // ── Insert ──────────────────────────────────────────────────────────────

  private insertKey(key: VimKey): true {
    if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
      if (this.cursor().col > 0) this.moveTo({ row: this.cursor().row, col: this.cursor().col - 1 })
      this.mode = "normal"
      this.snapshotChange()
      this.changed()
      return true
    }
    switch (key.name) {
      case "left":
        this.moveTo({ row: this.cursor().row, col: Math.max(0, this.cursor().col - 1) }, true)
        this.changed()
        return true
      case "right":
        this.moveTo({ row: this.cursor().row, col: this.cursor().col + 1 }, true)
        this.changed()
        return true
      case "up":
        this.moveTo({ row: this.cursor().row - 1, col: this.cursor().col }, true)
        this.changed()
        return true
      case "down":
        this.moveTo({ row: this.cursor().row + 1, col: this.cursor().col }, true)
        this.changed()
        return true
      case "home":
        this.moveTo({ row: this.cursor().row, col: 0 }, true)
        this.changed()
        return true
      case "end":
        this.moveTo({ row: this.cursor().row, col: this.lineLength(this.cursor().row) }, true)
        this.changed()
        return true
      case "backspace":
        this.buffer.deleteBackward()
        this.noteInsertKey("\u007f")
        this.finishEdit(true)
        return true
      case "delete":
        this.buffer.deleteCharAtCursor()
        this.finishEdit(true)
        return true
      case "return":
      case "linefeed":
      case "kpenter":
        this.buffer.newLine()
        this.noteInsertKey("\r")
        this.finishEdit(true)
        return true
      case "tab":
        this.buffer.insert("\t")
        this.noteInsertKey("\t")
        this.finishEdit(true)
        return true
    }
    if (key.ctrl && key.name === "w") {
      this.deleteWordBackward()
      this.finishEdit(true)
      return true
    }
    if (key.ctrl && key.name === "u") {
      const cur = this.cursor()
      this.buffer.deleteRange(cur, { row: cur.row, col: 0 })
      this.finishEdit(true)
      return true
    }
    const ch = charOf(key)
    if (ch) {
      this.buffer.insert(ch)
      this.noteInsertKey(ch)
      this.finishEdit(true)
    }
    return true
  }

  private deleteWordBackward() {
    const cur = this.cursor()
    const line = this.line(cur.row)
    let index = this.indexAt(cur.row, cur.col)
    while (index > 0 && spaceChar(line[index - 1])) index--
    const word = wordChar(line[index - 1])
    while (index > 0 && (word ? wordChar(line[index - 1]) : !spaceChar(line[index - 1]))) index--
    this.buffer.deleteRange(cur, { row: cur.row, col: this.cellAt(cur.row, index) })
  }

  // ── Normal / visual ─────────────────────────────────────────────────────

  private normalKey(key: VimKey): true {
    const ch = charOf(key)

    if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
      if (this.mode !== "normal") this.exitVisual()
      this.resetPending()
      this.message = ""
      this.buffer.clearSelection()
      this.changed()
      return true
    }

    if (this.mode === "visual" || this.mode === "visual-line") {
      if (this.visualKey(key, ch)) return true
    }

    if (ch === '"' && !this.operator) {
      this.awaitRegister = true
      this.changed()
      return true
    }

    if (ch !== undefined && /^[0-9]$/.test(ch)) {
      if (ch === "0" && !this.count && !this.operator) return this.motion("0", 1)
      this.count = this.count * 10 + Number(ch)
      this.changed()
      return true
    }

    const count = Math.max(1, this.count)

    if (this.operator) {
      if (ch === this.operator) {
        this.linewiseOperator(this.operator, count)
        this.resetPending()
        return true
      }
      if (this.operator !== "c" && (ch === "j" || ch === "k")) {
        const from = this.cursor().row
        const to = ch === "j" ? Math.min(this.buffer.lineCount() - 1, from + count) : Math.max(0, from - count)
        this.linewiseOperator(this.operator, to - from + 1, Math.min(from, to))
        this.resetPending()
        return true
      }
      const range = this.rangeFor(ch, count)
      if (range) {
        this.applyOperator(this.operator, range, ch)
        this.resetPending()
        return true
      }
      this.resetPending()
      this.changed()
      return true
    }

    if (this.gPrefix) {
      this.gPrefix = false
      if (ch === "g") return this.motion("gg", count)
      this.changed()
      return true
    }

    switch (ch) {
      case "h":
      case "l":
      case "j":
      case "k":
      case "w":
      case "b":
      case "e":
      case "W":
      case "B":
      case "E":
      case "{":
      case "}":
      case "^":
      case "$":
        return this.motion(ch, count)
      case "0":
        return this.motion("0", 1)
      case "G":
        return this.motion("G", this.count)
      case "H":
      case "M":
      case "L":
        return this.motion(ch, 1)
      case "g":
        this.gPrefix = true
        this.changed()
        return true
      case "f":
      case "t":
      case "F":
      case "T":
        this.awaitFind = ch
        this.changed()
        return true
      case ";":
        if (this.lastFind) this.findChar(this.lastFind.kind, this.lastFind.ch, count)
        return true
      case ",":
        if (this.lastFind) {
          const opposite = { f: "F", F: "f", t: "T", T: "t" } as const
          this.findChar(opposite[this.lastFind.kind], this.lastFind.ch, count)
        }
        return true
      case "%":
        this.matchBracket()
        return true
      case "d":
      case "y":
      case "c":
      case ">":
      case "<":
        this.operator = ch
        this.changed()
        return true
      case "x":
        this.deleteChars(count)
        return true
      case "X":
        this.deleteBefore(count)
        return true
      case "s":
        this.deleteChars(count)
        this.enterInsert("s")
        return true
      case "S":
        this.changeLines(count)
        return true
      case "C":
        this.deleteToEnd()
        this.enterInsert("c")
        return true
      case "D":
        this.deleteToEnd()
        return true
      case "Y":
        this.yankLines(count)
        return true
      case "p":
        this.put(count, true)
        return true
      case "P":
        this.put(count, false)
        return true
      case "r":
        this.awaitReplace = true
        return true
      case "J":
        this.joinLines(count)
        return true
      case "~":
        this.toggleCase(count)
        return true
      case "u":
        this.buffer.undo()
        this.finishEdit()
        return true
      case ".":
        this.repeatChange()
        return true
      case "i":
        this.enterInsert("i")
        return true
      case "a":
        this.moveTo({ row: this.cursor().row, col: this.cursor().col + 1 }, true)
        this.enterInsert("a")
        return true
      case "I":
        this.moveTo({ row: this.cursor().row, col: this.firstNonBlank(this.cursor().row) })
        this.enterInsert("I")
        return true
      case "A":
        this.moveTo({ row: this.cursor().row, col: this.lineLength(this.cursor().row) }, true)
        this.enterInsert("A")
        return true
      case "o":
        this.openLine(true)
        return true
      case "O":
        this.openLine(false)
        return true
      case "v":
        this.mode = "visual"
        this.visualAnchor = this.cursor()
        this.updateVisual()
        this.changed()
        return true
      case "V":
        this.mode = "visual-line"
        this.visualAnchor = this.cursor()
        this.updateVisual()
        this.changed()
        return true
      case "/":
        this.startPrompt("/")
        return true
      case "?":
        this.startPrompt("?")
        return true
      case "n":
        if (this.lastSearch) this.search(this.lastSearch.pattern, this.lastSearch.forward, true)
        return true
      case "N":
        if (this.lastSearch) this.search(this.lastSearch.pattern, !this.lastSearch.forward, true)
        return true
      case "*":
        this.searchWord(false)
        return true
      case "#":
        this.searchWord(true)
        return true
      case ":":
        this.startPrompt(":")
        return true
      case "m":
        this.awaitMark = "m"
        return true
      case "`":
        this.awaitMark = "`"
        return true
      case "'":
        this.awaitMark = "'"
        return true
      case "q":
        this.callbacks.onQuit?.(false)
        return true
    }

    // Arrow keys and paging work in normal mode like their vim equivalents.
    switch (key.name) {
      case "left":
        return this.motion("h", 1)
      case "right":
        return this.motion("l", 1)
      case "up":
        return this.motion("k", 1)
      case "down":
        return this.motion("j", 1)
      case "home":
        return this.motion("0", 1)
      case "end":
        return this.motion("$", 1)
      case "pageup":
        return this.scrollBy(-Math.max(1, this.buffer.viewportRows() - 1))
      case "pagedown":
        return this.scrollBy(Math.max(1, this.buffer.viewportRows() - 1))
      case "backspace":
        return this.motion("h", 1)
      case "delete":
        this.deleteChars(1)
        return true
    }

    if (key.ctrl) {
      switch (key.name) {
        case "d":
          return this.scrollBy(Math.max(1, Math.floor(this.buffer.viewportRows() / 2)))
        case "u":
          return this.scrollBy(-Math.max(1, Math.floor(this.buffer.viewportRows() / 2)))
        case "f":
          return this.scrollBy(Math.max(1, this.buffer.viewportRows() - 1))
        case "b":
          return this.scrollBy(-Math.max(1, this.buffer.viewportRows() - 1))
        case "r":
          this.buffer.redo()
          this.finishEdit()
          return true
        case "g":
          this.message = this.callbacks.name?.() ?? ""
          this.changed()
          return true
      }
      return true
    }

    this.message = ""
    this.changed()
    return true
  }

  private visualKey(key: VimKey, ch: string | undefined): boolean {
    const count = Math.max(1, this.count)
    const aliases: Record<string, string> = { left: "h", right: "l", up: "k", down: "j", home: "0", end: "$" }
    if (key.name in aliases) return this.motion(aliases[key.name]!, 1) as unknown as boolean
    const motions = ["h", "l", "j", "k", "w", "b", "e", "W", "B", "E", "^", "$", "{", "}", "0", "G"]
    if (ch && motions.includes(ch)) return this.motion(ch, ch === "0" || ch === "G" ? count : count) as unknown as boolean
    if (ch === "g") {
      this.gPrefix = true
      return true
    }
    if (this.gPrefix) {
      this.gPrefix = false
      if (ch === "g") return this.motion("gg", count) as unknown as boolean
      return true
    }
    if (ch === "o") {
      const anchor = this.visualAnchor
      if (anchor) {
        this.visualAnchor = this.cursor()
        this.buffer.setCursor(anchor)
        this.updateVisual()
      }
      this.changed()
      return true
    }
    if (ch === "d" || ch === "x" || ch === "y" || ch === "c" || ch === ">" || ch === "<" || ch === "~") {
      this.visualOperator(ch)
      return true
    }
    if (ch === "v" || ch === "V" || key.name === "escape") {
      this.exitVisual()
      this.changed()
      return true
    }
    return false
  }

  // ── Motions ─────────────────────────────────────────────────────────────

  private motion(kind: string, count: number): true {
    const cur = this.cursor()
    let target: Pos = cur
    switch (kind) {
      case "h":
        target = { row: cur.row, col: Math.max(0, cur.col - count) }
        break
      case "l":
        target = { row: cur.row, col: cur.col + count }
        break
      case "j":
        target = { row: cur.row + count, col: cur.col }
        break
      case "k":
        target = { row: cur.row - count, col: cur.col }
        break
      case "0":
        target = { row: cur.row, col: 0 }
        break
      case "^":
        target = { row: cur.row, col: this.firstNonBlank(cur.row) }
        break
      case "$":
        target = { row: cur.row, col: this.lineLength(cur.row) }
        break
      case "w":
      case "W":
        target = this.nextWord(cur, count, kind === "W")
        break
      case "b":
      case "B":
        target = this.prevWord(cur, count, kind === "B")
        break
      case "e":
      case "E":
        target = this.endOfWord(cur, count, kind === "E")
        break
      case "{":
      case "}":
        target = this.paragraph(cur, kind === "}" ? 1 : -1, count)
        break
      case "G":
        target = {
          row: count ? Math.min(this.buffer.lineCount() - 1, count - 1) : this.buffer.lineCount() - 1,
          col: 0,
        }
        break
      case "gg":
        target = { row: count ? Math.min(this.buffer.lineCount() - 1, count - 1) : 0, col: 0 }
        break
      case "H":
        target = { row: this.buffer.viewportTop(), col: 0 }
        break
      case "M":
        target = {
          row: this.buffer.viewportTop() + Math.floor(this.buffer.viewportRows() / 2),
          col: 0,
        }
        break
      case "L":
        target = { row: this.buffer.viewportTop() + this.buffer.viewportRows() - 1, col: 0 }
        break
      default:
        return true
    }
    const allowEnd = this.mode === "insert"
    this.moveTo(target, allowEnd)
    if (this.mode === "visual" || this.mode === "visual-line") this.updateVisual()
    this.count = 0
    this.changed()
    return true
  }

  private firstNonBlank(row: number) {
    const line = this.line(row)
    const spaces = /^\s*/.exec(line)?.[0].length ?? 0
    return this.cellAt(row, spaces)
  }

  private skipWhitespaceForward(row: number, index: number, big: boolean) {
    const line = this.line(row)
    while (index < line.length) {
      const ch = line[index]
      if (big ? spaceChar(ch) : ch === " " || ch === "\t") index++
      else break
    }
    return index
  }

  private nextWord(from: Pos, count: number, big: boolean): Pos {
    let row = from.row
    let index = this.indexAt(from.row, from.col)
    for (let n = 0; n < count; n++) {
      const line = this.line(row)
      // Move off the current word, then to the next word start.
      if (index < line.length) {
        const atWord = big ? !spaceChar(line[index]) : wordChar(line[index])
        while (index < line.length && (big ? !spaceChar(line[index]) : wordChar(line[index])) === atWord) index++
      }
      index = this.skipWhitespaceForward(row, index, big)
      while (index >= line.length && row < this.buffer.lineCount() - 1) {
        row++
        index = 0
        index = this.skipWhitespaceForward(row, index, big)
        if (index < this.line(row).length) break
      }
      if (index >= this.line(row).length && row >= this.buffer.lineCount() - 1) {
        return { row: this.buffer.lineCount() - 1, col: Math.max(0, this.lineLength(row) - 1) }
      }
    }
    return { row, col: this.cellAt(row, index) }
  }

  private prevWord(from: Pos, count: number, big: boolean): Pos {
    let row = from.row
    let index = this.indexAt(from.row, from.col)
    for (let n = 0; n < count; n++) {
      let guard = 0
      do {
        if (index > 0) index--
        else if (row > 0) {
          row--
          index = this.line(row).length
        } else return { row: 0, col: 0 }
        guard++
      } while (guard < 1_000_000 && index > 0 && spaceChar(this.line(row)[index]))
      const word = big ? !spaceChar(this.line(row)[index]) : wordChar(this.line(row)[index])
      while (index > 0 && (big ? !spaceChar(this.line(row)[index - 1]) : wordChar(this.line(row)[index - 1])) === word) index--
    }
    return { row, col: this.cellAt(row, index) }
  }

  private endOfWord(from: Pos, count: number, big: boolean): Pos {
    let row = from.row
    let index = this.indexAt(from.row, from.col)
    for (let n = 0; n < count; n++) {
      if (index < this.line(row).length) index++
      const line = this.line(row)
      while (index < line.length && (big ? spaceChar(line[index]) : !wordChar(line[index]))) index++
      while (index + 1 < line.length && (big ? !spaceChar(line[index + 1]) : wordChar(line[index + 1]))) index++
      if (index >= line.length && row < this.buffer.lineCount() - 1) {
        row++
        index = 0
        const next = this.line(row)
        index = this.skipWhitespaceForward(row, 0, big)
        while (index + 1 < next.length && (big ? !spaceChar(next[index + 1]) : wordChar(next[index + 1]))) index++
      }
    }
    return { row, col: this.cellAt(row, Math.min(index, this.line(row).length)) }
  }

  private paragraph(from: Pos, direction: 1 | -1, count: number): Pos {
    let row = from.row
    for (let n = 0; n < count; n++) {
      let next = row
      for (;;) {
        const candidate = next + direction
        if (candidate < 0 || candidate >= this.buffer.lineCount()) break
        next = candidate
        if (this.line(next).trim() === "") break
      }
      row = next
    }
    return { row, col: 0 }
  }

  private scrollBy(delta: number): true {
    this.moveTo({ row: this.cursor().row + delta, col: this.cursor().col })
    this.changed()
    return true
  }

  private findChar(kind: "f" | "t" | "F" | "T", ch: string, count: number) {
    const cur = this.cursor()
    const line = this.line(cur.row)
    let index = this.indexAt(cur.row, cur.col)
    for (let n = 0; n < count; n++) {
      if (kind === "f" || kind === "t") {
        const at = line.indexOf(ch, index + 1)
        if (at < 0) return
        index = kind === "t" ? at - 1 : at
      } else {
        const at = line.lastIndexOf(ch, index - 1)
        if (at < 0) return
        index = kind === "T" ? at + 1 : at
      }
    }
    this.moveTo({ row: cur.row, col: this.cellAt(cur.row, Math.max(0, index)) })
    this.changed()
  }

  private matchBracket() {
    const cur = this.cursor()
    const line = this.line(cur.row)
    const index = this.indexAt(cur.row, cur.col)
    const root = line[index]
    if (!root) return
    const open: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
    const close: Record<string, string> = { ")": "(", "]": "[", "}": "{" }
    const text = this.buffer.text().split("\n")
    if (open[root]) {
      let depth = 0
      let row = cur.row
      let at = index
      while (row < text.length) {
        const source = text[row]!
        for (; at < source.length; at++) {
          if (source[at] === root) depth++
          else if (source[at] === open[root]) {
            depth--
            if (depth === 0) {
              this.moveTo({ row, col: this.cellAt(row, at) })
              this.changed()
              return
            }
          }
        }
        row++
        at = 0
      }
      return
    }
    if (close[root]) {
      let depth = 0
      let row = cur.row
      let at = index
      while (row >= 0) {
        const source = text[row]!
        for (; at >= 0; at--) {
          if (source[at] === root) depth++
          else if (source[at] === close[root]) {
            depth--
            if (depth === 0) {
              this.moveTo({ row, col: this.cellAt(row, at) })
              this.changed()
              return
            }
          }
        }
        row--
        at = row >= 0 ? (text[row]!.length - 1) : -1
      }
    }
  }

  // ── Operator ranges ─────────────────────────────────────────────────────

  private rangeFor(motion: string | undefined, count: number): Range | undefined {
    if (!motion) return undefined
    const cur = this.cursor()
    const linewiseTo = (row: number): Range => {
      const startRow = Math.min(cur.row, row)
      const endRow = Math.max(cur.row, row)
      return {
        start: { row: startRow, col: 0 },
        end: { row: endRow, col: this.lineLength(endRow) },
        linewise: true,
      }
    }
    switch (motion) {
      case "j":
        return linewiseTo(Math.min(this.buffer.lineCount() - 1, cur.row + count))
      case "k":
        return linewiseTo(Math.max(0, cur.row - count))
      case "G":
        return linewiseTo(count ? Math.min(this.buffer.lineCount() - 1, count - 1) : this.buffer.lineCount() - 1)
      case "h":
        return { start: { row: cur.row, col: Math.max(0, cur.col - count) }, end: cur, linewise: false }
      case "l":
        return { start: cur, end: { row: cur.row, col: cur.col + count }, linewise: false }
      case "0":
        return { start: { row: cur.row, col: 0 }, end: cur, linewise: false }
      case "^":
        return { start: { row: cur.row, col: this.firstNonBlank(cur.row) }, end: cur, linewise: false }
      case "$":
        return { start: cur, end: { row: cur.row, col: this.lineLength(cur.row) }, linewise: false }
      case "w":
      case "W": {
        const end = this.nextWord(cur, count, motion === "W")
        return { start: cur, end, linewise: false }
      }
      case "b":
      case "B":
        return { start: this.prevWord(cur, count, motion === "B"), end: cur, linewise: false }
      case "e":
      case "E": {
        const end = this.endOfWord(cur, count, motion === "E")
        return { start: cur, end: { row: end.row, col: end.col + 1 }, linewise: false }
      }
      case "{":
        return linewiseTo(this.paragraph(cur, -1, count).row)
      case "}":
        return linewiseTo(this.paragraph(cur, 1, count).row)
    }
    return undefined
  }

  private applyOperator(op: "d" | "y" | "c" | ">" | "<", range: Range, motion?: string) {
    if (op === "y") return this.yankRange(range)
    if (op === ">" || op === "<") return this.indent(range.start.row, range.end.row, op === ">")
    if (range.linewise) return this.changeOrDeleteLines(range.start.row, range.end.row - range.start.row + 1, op === "c")
    // `cw`/`cW` stop at the end of the word, like vim, instead of at the next word start.
    if (op === "c" && (motion === "w" || motion === "W")) {
      const end = this.endOfWord(this.cursor(), Math.max(1, this.count), motion === "W")
      range = { start: this.cursor(), end: { row: end.row, col: end.col + 1 }, linewise: false }
    }
    const [a, b] = this.ordered(range.start, range.end)
    this.buffer.deleteRange(a, b)
    this.moveTo(a)
    this.finishEdit()
    if (op === "c") this.enterInsert("c")
  }

  private ordered(a: Pos, b: Pos): [Pos, Pos] {
    return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a]
  }

  private yankRange(range: Range) {
    const [a, b] = this.ordered(range.start, range.end)
    const text = range.linewise
      ? this.lines().slice(a.row, b.row + 1).join("\n")
      : this.rangeText(a, b)
    this.storeRegister(text, range.linewise)
    this.message = range.linewise ? `${b.row - a.row + 1} lines yanked` : "yanked"
    this.changed()
  }

  private storeRegister(text: string, linewise: boolean) {
    this.register = text
    this.registerLinewise = linewise
    const reg = this.pendingRegister
    this.pendingRegister = undefined
    if (reg && /^[a-z]$/.test(reg)) this.namedRegisters.set(reg, { text, linewise })
    if (reg === "+" || reg === "*") this.buffer.writeClipboard?.(text)
  }

  private linewiseOperator(op: string, count: number, fromRow = this.cursor().row) {
    if (op === "y") {
      const start = { row: fromRow, col: 0 }
      const endRow = Math.min(this.buffer.lineCount() - 1, fromRow + count - 1)
      this.yankRange({ start, end: { row: endRow, col: this.lineLength(endRow) }, linewise: true })
      return
    }
    if (op === ">" || op === "<") return this.indent(fromRow, Math.min(this.buffer.lineCount() - 1, fromRow + count - 1), op === ">")
    this.changeOrDeleteLines(fromRow, count, op === "c")
  }

  private changeOrDeleteLines(fromRow: number, count: number, change: boolean) {
    const endRow = Math.min(this.buffer.lineCount() - 1, fromRow + count - 1)
    const text = this.lines().slice(fromRow, endRow + 1).join("\n")
    this.storeRegister(text, true)
    const lastRow = this.buffer.lineCount() - 1
    if (endRow < lastRow) {
      this.buffer.deleteRange({ row: fromRow, col: 0 }, { row: endRow + 1, col: 0 })
    } else if (fromRow > 0) {
      this.buffer.deleteRange(
        { row: fromRow - 1, col: this.lineLength(fromRow - 1) },
        { row: endRow, col: this.lineLength(endRow) },
      )
    } else {
      this.buffer.deleteRange({ row: 0, col: 0 }, { row: endRow, col: this.lineLength(endRow) })
    }
    if (change) {
      if (lastRow === 0) {
        // Only line in the document: keep a single empty line for the insert.
        this.buffer.setCursor({ row: 0, col: 0 })
        this.buffer.insert("")
      }
    }
    this.moveTo({ row: Math.min(fromRow, Math.max(0, this.buffer.lineCount() - 1)), col: 0 })
    this.finishEdit()
    if (change) this.enterInsert("c")
  }

  // ── Edits ───────────────────────────────────────────────────────────────

  private deleteChars(count: number) {
    for (let i = 0; i < count; i++) this.buffer.deleteCharAtCursor()
    this.finishEdit()
  }

  private deleteBefore(count: number) {
    for (let i = 0; i < count; i++) this.buffer.deleteBackward()
    this.finishEdit()
  }

  private deleteToEnd() {
    const cur = this.cursor()
    this.buffer.deleteRange(cur, { row: cur.row, col: this.lineLength(cur.row) })
    this.finishEdit()
  }

  private changeLines(count: number) {
    void count
    const row = this.cursor().row
    this.buffer.deleteRange({ row, col: 0 }, { row, col: this.lineLength(row) })
    this.moveTo({ row, col: 0 })
    this.finishEdit()
    this.enterInsert("S")
  }

  private yankLines(count: number) {
    const start = this.cursor().row
    const end = Math.min(this.buffer.lineCount() - 1, start + count - 1)
    this.yankRange({ start: { row: start, col: 0 }, end: { row: end, col: this.lineLength(end) }, linewise: true })
  }

  private replaceChar(ch: string, count: number) {
    const cur = this.cursor()
    const line = this.line(cur.row)
    let index = this.indexAt(cur.row, cur.col)
    let width = 0
    for (let n = 0; n < count && index < line.length; n++) {
      const target = [...line.slice(index)][0] ?? ""
      if (!target) break
      width += Math.max(1, this.buffer.measure(target))
      index += target.length
    }
    if (!width) return
    const start = cur
    this.buffer.deleteRange(start, { row: cur.row, col: cur.col + width })
    this.buffer.setCursor(start)
    this.buffer.insert(ch.repeat(count))
    this.moveTo({ row: cur.row, col: cur.col + Math.max(0, width - 1) })
    this.finishEdit()
  }

  private joinLines(count: number) {
    for (let i = 0; i < count; i++) {
      const row = this.cursor().row
      if (row >= this.buffer.lineCount() - 1) break
      const column = this.lineLength(row)
      this.buffer.setCursor({ row, col: column })
      this.buffer.deleteCharAtCursor()
      this.buffer.insert(" ")
      this.moveTo({ row, col: column })
    }
    this.finishEdit()
  }

  private toggleCase(count: number) {
    const cur = this.cursor()
    const line = this.line(cur.row)
    let index = this.indexAt(cur.row, cur.col)
    for (let n = 0; n < count && index < line.length; n++) {
      const ch = [...line.slice(index)][0]
      if (!ch) break
      const swapped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()
      const col = this.cellAt(cur.row, index)
      this.buffer.setCursor({ row: cur.row, col })
      this.buffer.deleteCharAtCursor()
      this.buffer.insert(swapped)
      index += ch.length
    }
    this.moveTo({ row: cur.row, col: cur.col })
    this.finishEdit()
  }

  private indent(fromRow: number, toRow: number, increase: boolean) {
    for (let row = Math.max(0, fromRow); row <= Math.min(toRow, this.buffer.lineCount() - 1); row++) {
      this.buffer.setCursor({ row, col: 0 })
      if (increase) this.buffer.insert("  ")
      else if (this.line(row).startsWith("  ")) this.buffer.deleteRange({ row, col: 0 }, { row, col: 2 })
    }
    this.moveTo({ row: Math.max(0, fromRow), col: 0 })
    this.finishEdit()
  }

  private openLine(below: boolean) {
    const cur = this.cursor()
    if (below) {
      this.buffer.setCursor({ row: cur.row, col: this.lineLength(cur.row) })
      this.buffer.newLine()
    } else {
      this.buffer.setCursor({ row: cur.row, col: 0 })
      this.buffer.newLine()
      this.moveTo({ row: cur.row, col: 0 }, true)
    }
    this.markDirty()
    this.invalidate()
    this.enterInsert(below ? "o" : "O")
  }

  private put(count: number, after: boolean) {
    const named = this.pendingRegister && /^[a-z]$/.test(this.pendingRegister)
      ? this.namedRegisters.get(this.pendingRegister)
      : undefined
    const text = named?.text ?? this.register
    const linewise = named?.linewise ?? this.registerLinewise
    this.pendingRegister = undefined
    if (!text) {
      this.message = "Nothing in register"
      this.changed()
      return
    }
    const cur = this.cursor()
    if (linewise) {
      if (after && cur.row < this.buffer.lineCount() - 1) {
        this.buffer.setCursor({ row: cur.row, col: this.lineLength(cur.row) })
      }
      for (let i = 0; i < count; i++) {
        this.buffer.newLine()
        this.buffer.insert(text)
      }
      this.moveTo({ row: Math.min(this.buffer.lineCount() - 1, cur.row + 1), col: 0 })
    } else {
      const column = after ? Math.min(cur.col + 1, this.lineLength(cur.row)) : cur.col
      this.buffer.setCursor({ row: cur.row, col: column })
      this.buffer.insert(text.repeat(count))
      this.moveTo({ row: cur.row, col: Math.max(0, column + text.length * count - 1) })
    }
    this.finishEdit()
  }

  // ── Visual ──────────────────────────────────────────────────────────────

  private updateVisual() {
    const anchor = this.visualAnchor
    if (!anchor) return
    const cur = this.cursor()
    if (this.mode === "visual-line") {
      const startRow = Math.min(anchor.row, cur.row)
      const endRow = Math.max(anchor.row, cur.row)
      this.buffer.select({ row: startRow, col: 0 }, { row: endRow, col: this.lineLength(endRow) })
      return
    }
    const [a, b] = this.ordered(anchor, cur)
    this.buffer.select(a, { row: b.row, col: b.col + 1 })
  }

  private exitVisual() {
    this.mode = "normal"
    this.visualAnchor = undefined
    this.buffer.clearSelection()
  }

  private visualOperator(op: "d" | "y" | "c" | ">" | "<" | "x" | "~") {
    const anchor = this.visualAnchor
    if (!anchor) return
    const cur = this.cursor()
    const linewise = this.mode === "visual-line"
    this.exitVisual()
    if (linewise) {
      const startRow = Math.min(anchor.row, cur.row)
      const endRow = Math.max(anchor.row, cur.row)
      if (op === "y") {
        this.yankRange({ start: { row: startRow, col: 0 }, end: { row: endRow, col: this.lineLength(endRow) }, linewise: true })
        this.moveTo({ row: startRow, col: 0 })
        return
      }
      if (op === ">" || op === "<") {
        this.indent(startRow, endRow, op === ">")
        return
      }
      this.changeOrDeleteLines(startRow, endRow - startRow + 1, op === "c")
      return
    }
    const [a, b] = this.ordered(anchor, cur)
    const end = { row: b.row, col: Math.min(this.lineLength(b.row), b.col + 1) }
    if (op === "y") {
      this.yankRange({ start: a, end, linewise: false })
      this.moveTo(a)
      return
    }
    if (op === ">" || op === "<") {
      this.indent(a.row, end.row, op === ">")
      return
    }
    if (op === "~") {
      const text = this.rangeText(a, end)
      this.buffer.deleteRange(a, end)
      this.buffer.setCursor(a)
      this.buffer.insert(
        [...text]
          .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
          .join(""),
      )
      this.moveTo(a)
      this.finishEdit()
      return
    }
    this.buffer.deleteRange(a, end)
    this.moveTo(a)
    this.finishEdit()
    if (op === "c") this.enterInsert("c")
  }

  // ── Search ──────────────────────────────────────────────────────────────

  private search(pattern: string, forward: boolean, skipCurrent: boolean) {
    if (!pattern) return
    this.lastSearch = { pattern, forward }
    let source: RegExp | undefined
    try {
      source = new RegExp(pattern)
    } catch {
      source = undefined
    }
    const matches = (line: string): number[] => {
      const found: number[] = []
      if (!source) {
        let at = line.indexOf(pattern)
        while (at >= 0) {
          found.push(at)
          at = line.indexOf(pattern, at + 1)
        }
        return found
      }
      const re = new RegExp(source.source, source.flags.includes("g") ? source.flags : source.flags + "g")
      for (let m = re.exec(line); m; m = re.exec(line)) {
        found.push(m.index)
        if (m[0].length === 0) re.lastIndex++
      }
      return found
    }
    const cur = this.cursor()
    if (forward) {
      for (let row = cur.row; row < this.buffer.lineCount(); row++) {
        const at = matches(this.line(row)).find(
          (index) => row > cur.row || this.cellAt(row, index) > cur.col || (!skipCurrent && this.cellAt(row, index) === cur.col),
        )
        if (at !== undefined) {
          this.moveTo({ row, col: this.cellAt(row, at) })
          this.message = `/${pattern}`
          this.changed()
          return
        }
      }
    } else {
      for (let row = cur.row; row >= 0; row--) {
        const found = matches(this.line(row)).filter(
          (index) => row < cur.row || this.cellAt(row, index) < cur.col || (!skipCurrent && this.cellAt(row, index) === cur.col),
        )
        const at = found.at(-1)
        if (at !== undefined) {
          this.moveTo({ row, col: this.cellAt(row, at) })
          this.message = `?${pattern}`
          this.changed()
          return
        }
      }
    }
    this.message = `Pattern not found: ${pattern}`
    this.changed()
  }

  private searchWord(backward: boolean) {
    const cur = this.cursor()
    const line = this.line(cur.row)
    const index = this.indexAt(cur.row, cur.col)
    const word = /^[A-Za-z0-9_]+/.exec(line.slice(index))?.[0]
    if (!word) return
    this.search(word, !backward, false)
  }

  // ── Ex ──────────────────────────────────────────────────────────────────

  private ex(input: string) {
    const text = input.trim()
    if (!text) return
    if (/^\d+$/.test(text)) {
      this.moveTo({ row: Number(text) - 1, col: 0 })
      this.changed()
      return
    }
    const [name = "", ...rest] = text.split(/\s+/)
    const args = rest.join(" ")
    switch (name) {
      case "q":
      case "quit":
        if (this.dirty) {
          this.message = "No write since last change (add ! to override)"
          this.changed()
          return
        }
        this.callbacks.onQuit?.(false)
        return
      case "q!":
      case "quit!":
        this.callbacks.onQuit?.(true)
        return
      case "w":
      case "write":
      case "w!":
        void this.callbacks.onWrite?.(args || undefined)
        return
      case "wq":
      case "x":
      case "xit":
        void Promise.resolve(this.callbacks.onWrite?.(args || undefined)).then(() => this.callbacks.onQuit?.(false))
        return
      case "e":
      case "edit":
        void this.callbacks.onEdit?.(args || undefined, false)
        return
      case "e!":
      case "edit!":
        void this.callbacks.onEdit?.(args || undefined, true)
        return
      default:
        if (this.callbacks.onExCommand?.(name, args)) return
        this.message = `Not an editor command: ${name}`
        this.changed()
    }
  }

  // ── Repeat ──────────────────────────────────────────────────────────────

  private record(key: VimKey) {
    const ch = charOf(key)
    if (ch) this.recording!.push(ch)
    else if (key.name === "escape") this.recording!.push("\u001b")
    else if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") this.recording!.push("\r")
    else if (key.name === "backspace") this.recording!.push("\u007f")
    else if (key.name === "tab") this.recording!.push("\t")
  }

  private enterInsert(entry: "i" | "a" | "I" | "A" | "o" | "O" | "s" | "S" | "c" = "i") {
    this.insertEntry = entry
    this.insertKeys = []
    this.mode = "insert"
    this.count = 0
    this.message = ""
    this.changed()
  }

  private noteInsertKey(token: string) {
    this.insertKeys.push(token)
  }

  private snapshotChange() {
    this.lastChange = { type: "insert", entry: this.insertEntry, keys: [...this.insertKeys] }
    this.recording = []
    this.changedSinceSnapshot = false
  }

  private repeatChange() {
    const change = this.lastChange
    if (!change || (change.type === "keys" && change.keys.length === 0)) {
      this.message = "No change to repeat"
      this.changed()
      return
    }
    this.replaying = true
    try {
      if (change.type === "insert") {
        const entry = change.entry
        if (entry === "o") this.openLine(true)
        else if (entry === "O") this.openLine(false)
        else {
          const cursor = this.cursor()
          if (entry === "A") this.moveTo({ row: cursor.row, col: this.lineLength(cursor.row) }, true)
          else if (entry === "I") this.moveTo({ row: cursor.row, col: this.firstNonBlank(cursor.row) })
          else this.moveTo({ row: cursor.row, col: cursor.col + 1 }, true)
          this.insertEntry = entry
          this.insertKeys = []
          this.mode = "insert"
        }
        for (const token of change.keys) this.typeInsertToken(token)
        this.handleKey({ name: "escape", ctrl: false, meta: false, shift: false })
        return
      }
      for (const ch of change.keys) {
        switch (ch) {
          case "\u001b":
            this.handleKey({ name: "escape", ctrl: false, meta: false, shift: false })
            break
          case "\r":
            this.handleKey({ name: "return", ctrl: false, meta: false, shift: false })
            break
          case "\u007f":
            this.handleKey({ name: "backspace", ctrl: false, meta: false, shift: false })
            break
          case "\t":
            this.handleKey({ name: "tab", ctrl: false, meta: false, shift: false })
            break
          default:
            this.handleKey({ name: ch, ctrl: false, meta: false, shift: false })
        }
      }
    } finally {
      this.replaying = false
    }
  }

  private typeInsertToken(token: string) {
    switch (token) {
      case "\r":
        this.handleKey({ name: "return", ctrl: false, meta: false, shift: false })
        break
      case "\u007f":
        this.handleKey({ name: "backspace", ctrl: false, meta: false, shift: false })
        break
      case "\t":
        this.handleKey({ name: "tab", ctrl: false, meta: false, shift: false })
        break
      default:
        this.handleKey({ name: token, ctrl: false, meta: false, shift: false })
    }
  }
}
