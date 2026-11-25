// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict"
import { test } from "node:test"
import { Vim, type Pos, type VimBuffer, type VimKey } from "../vim/engine.ts"

/** ASCII-only in-memory VimBuffer; cell columns equal string indices. */
class Fake implements VimBuffer {
  value: string
  row = 0
  col = 0
  selection: { start: Pos; end: Pos } | undefined
  clipboard = ""
  private undoStack: string[] = []
  private redoStack: string[] = []

  constructor(value: string) {
    this.value = value
  }

  text() {
    return this.value
  }
  lineCount() {
    return this.value.split("\n").length
  }
  cursor(): Pos {
    return { row: this.row, col: this.col }
  }
  setCursor(pos: Pos) {
    const lines = this.value.split("\n")
    this.row = Math.max(0, Math.min(lines.length - 1, pos.row))
    this.col = Math.max(0, Math.min((lines[this.row] ?? "").length, pos.col))
  }
  measure(text: string) {
    return [...text].length
  }
  private offset(row = this.row, col = this.col) {
    const lines = this.value.split("\n")
    let at = 0
    for (let i = 0; i < row; i++) at += (lines[i] ?? "").length + 1
    return at + col
  }
  private snapshot() {
    this.undoStack.push(this.value)
    this.redoStack = []
  }
  insert(text: string) {
    this.snapshot()
    const at = this.offset()
    this.value = this.value.slice(0, at) + text + this.value.slice(at)
    const added = text.split("\n")
    if (added.length > 1) {
      this.row += added.length - 1
      this.col = added.at(-1)!.length
    } else {
      this.col += text.length
    }
  }
  newLine() {
    this.insert("\n")
  }
  deleteCharAtCursor() {
    if (this.offset() >= this.value.length) return
    this.snapshot()
    this.value = this.value.slice(0, this.offset()) + this.value.slice(this.offset() + 1)
  }
  deleteBackward() {
    if (this.offset() === 0) return
    this.snapshot()
    this.value = this.value.slice(0, this.offset() - 1) + this.value.slice(this.offset())
    this.back()
  }
  deleteRange(start: Pos, end: Pos) {
    const a = this.offset(start.row, start.col)
    const b = this.offset(end.row, end.col)
    this.snapshot()
    this.value = this.value.slice(0, a) + this.value.slice(b)
    this.row = start.row
    this.col = start.col
  }
  undo() {
    const previous = this.undoStack.pop()
    if (previous === undefined) return
    this.redoStack.push(this.value)
    this.value = previous
    this.row = 0
    this.col = 0
  }
  redo() {
    const next = this.redoStack.pop()
    if (next === undefined) return
    this.undoStack.push(this.value)
    this.value = next
    this.row = 0
    this.col = 0
  }
  select(start: Pos, end: Pos) {
    this.selection = { start, end }
  }
  clearSelection() {
    this.selection = undefined
  }
  viewportRows() {
    return 10
  }
  viewportTop() {
    return 0
  }
  writeClipboard(text: string) {
    this.clipboard = text
  }
  private back() {
    if (this.col > 0) this.col--
    else if (this.row > 0) {
      this.row--
      this.col = (this.value.split("\n")[this.row] ?? "").length
    }
  }
}

const key = (name: string, extra: Partial<VimKey> = {}): VimKey => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...extra,
})

const press = (vim: Vim, keys: string): void => {
  for (const ch of keys) vim.handleKey(key(ch))
}

const fixture = (text: string) => {
  const buffer = new Fake(text)
  const vim = new Vim(buffer)
  return { buffer, vim }
}

test("horizontal and vertical motions", () => {
  const { buffer, vim } = fixture("hello\nworld\nthird")
  press(vim, "ll")
  assert.deepEqual(buffer.cursor(), { row: 0, col: 2 })
  press(vim, "jj")
  assert.deepEqual(buffer.cursor(), { row: 2, col: 2 })
  press(vim, "0")
  assert.deepEqual(buffer.cursor(), { row: 2, col: 0 })
  press(vim, "$")
  assert.deepEqual(buffer.cursor(), { row: 2, col: 4 })
  press(vim, "kkh")
  assert.deepEqual(buffer.cursor(), { row: 0, col: 3 })
})

test("l stops on the last character in normal mode", () => {
  const { buffer, vim } = fixture("ab")
  press(vim, "lllll")
  assert.deepEqual(buffer.cursor(), { row: 0, col: 1 })
})

test("counts apply to motions", () => {
  const { buffer, vim } = fixture("a\nb\nc\nd")
  press(vim, "3j")
  assert.equal(buffer.cursor().row, 3)
  const second = fixture("abcdef")
  press(second.vim, "4l")
  assert.equal(second.buffer.cursor().col, 4)
})

test("G and gg jump to the document edges", () => {
  const { buffer, vim } = fixture("a\nb\nc\nd\ne")
  press(vim, "G")
  assert.equal(buffer.cursor().row, 4)
  press(vim, "gg")
  assert.equal(buffer.cursor().row, 0)
  press(vim, "3G")
  assert.equal(buffer.cursor().row, 2)
})

test("word motions", () => {
  const { buffer, vim } = fixture("one two three")
  press(vim, "w")
  assert.equal(buffer.cursor().col, 4)
  press(vim, "w")
  assert.equal(buffer.cursor().col, 8)
  press(vim, "b")
  assert.equal(buffer.cursor().col, 4)
  press(vim, "e")
  assert.equal(buffer.cursor().col, 6)
})

test("x deletes forward and X deletes backward", () => {
  const { buffer, vim } = fixture("hello")
  press(vim, "x")
  assert.equal(buffer.text(), "ello")
  press(vim, "3x")
  assert.equal(buffer.text(), "o")
  const back = fixture("abc")
  press(back.vim, "llX")
  assert.equal(back.buffer.text(), "ac")
})

test("dd removes a line and yy/p round-trips it", () => {
  const { buffer, vim } = fixture("alpha\nbeta\ngamma")
  press(vim, "dd")
  assert.equal(buffer.text(), "beta\ngamma")
  press(vim, "yy")
  press(vim, "p")
  assert.equal(buffer.text(), "beta\nbeta\ngamma")
})

test("dd on the last line leaves no trailing blank line", () => {
  const { buffer, vim } = fixture("alpha\nbeta")
  press(vim, "Gdd")
  assert.equal(buffer.text(), "alpha")
})

test("dw deletes to the next word and cw stops at the word end", () => {
  const first = fixture("foo bar baz")
  press(first.vim, "dw")
  assert.equal(first.buffer.text(), "bar baz")

  const second = fixture("foo bar baz")
  press(second.vim, "cw")
  press(second.vim, "qux")
  second.vim.handleKey(key("escape"))
  assert.equal(second.buffer.text(), "qux bar baz")
})

test("D deletes to the end of the line", () => {
  const { buffer, vim } = fixture("hello world\nnext")
  press(vim, "wD")
  assert.equal(buffer.text(), "hello \nnext")
})

test("insert mode edits and escape steps left", () => {
  const { buffer, vim } = fixture("ab")
  press(vim, "lli")
  press(vim, "XY")
  vim.handleKey(key("escape"))
  assert.equal(buffer.text(), "aXYb")
  assert.deepEqual(buffer.cursor(), { row: 0, col: 2 })
})

test("a, A and o open insertion points", () => {
  const a = fixture("ab")
  press(a.vim, "a hi")
  a.vim.handleKey(key("escape"))
  assert.equal(a.buffer.text(), "a hib")

  const A = fixture("ab")
  press(A.vim, "A!")
  A.vim.handleKey(key("escape"))
  assert.equal(A.buffer.text(), "ab!")

  const o = fixture("ab")
  press(o.vim, "oxy")
  o.vim.handleKey(key("escape"))
  assert.equal(o.buffer.text(), "ab\nxy")
})

test("insert mode backspace, delete and newline", () => {
  const { buffer, vim } = fixture("ab")
  press(vim, "A")
  press(vim, "cd")
  vim.handleKey(key("backspace"))
  assert.equal(buffer.text(), "abc")
  vim.handleKey(key("delete"))
  assert.equal(buffer.text(), "abc")
  vim.handleKey(key("return"))
  press(vim, "x")
  vim.handleKey(key("escape"))
  assert.equal(buffer.text(), "abc\nx")
})

test("visual selection is reported and d removes it", () => {
  const { buffer, vim } = fixture("hello")
  press(vim, "vl")
  assert.ok(buffer.selection)
  assert.deepEqual(buffer.selection, { start: { row: 0, col: 0 }, end: { row: 0, col: 2 } })
  press(vim, "d")
  assert.equal(buffer.text(), "llo")
  assert.equal(buffer.selection, undefined)
})

test("visual line mode deletes whole lines", () => {
  const { buffer, vim } = fixture("a\nb\nc\nd")
  press(vim, "Vjd")
  assert.equal(buffer.text(), "c\nd")
})

test("undo and redo", () => {
  const { buffer, vim } = fixture("hello")
  press(vim, "x")
  assert.equal(buffer.text(), "ello")
  press(vim, "u")
  assert.equal(buffer.text(), "hello")
  vim.handleKey(key("r", { ctrl: true }))
  assert.equal(buffer.text(), "ello")
})

test("search finds the next match and n repeats", () => {
  const { buffer, vim } = fixture("alpha beta\ngamma beta")
  vim.handleKey(key("/"))
  for (const ch of "beta") vim.handleKey(key(ch))
  vim.handleKey(key("return"))
  assert.deepEqual(buffer.cursor(), { row: 0, col: 6 })
  press(vim, "n")
  assert.deepEqual(buffer.cursor(), { row: 1, col: 6 })
})

test("command line: line number jumps, :q and :w callbacks", () => {
  const { buffer } = fixture("a\nb\nc")
  const events: string[] = []
  const engine = new Vim(buffer, {
    onQuit: (force) => events.push(`quit:${force}`),
    onWrite: (target) => {
      events.push(`write:${target ?? ""}`)
    },
  })
  const run = (line: string) => {
    engine.handleKey(key(":"))
    for (const ch of line) engine.handleKey(key(ch))
    engine.handleKey(key("return"))
  }
  run("3")
  assert.equal(buffer.cursor().row, 2)
  run("w")
  assert.deepEqual(events, ["write:"])
  run("q")
  assert.deepEqual(events, ["write:", "quit:false"])
  run("q!")
  assert.deepEqual(events, ["write:", "quit:false", "quit:true"])
})

test("dirty tracking follows edits and :q without :q! warns", () => {
  const { buffer } = fixture("abc")
  const events: string[] = []
  const engine = new Vim(buffer, { onQuit: (force) => events.push(String(force)) })
  engine.handleKey(key("x"))
  assert.equal(engine.status().dirty, true)
  engine.handleKey(key(":"))
  for (const ch of "q") engine.handleKey(key(ch))
  engine.handleKey(key("return"))
  assert.deepEqual(events, [])
  assert.match(engine.status().message, /No write/)
})

test(". repeats the last change", () => {
  const { buffer, vim } = fixture("aaaa")
  press(vim, "x")
  assert.equal(buffer.text(), "aaa")
  press(vim, ".")
  assert.equal(buffer.text(), "aa")
})

test(". repeats an insert change", () => {
  const { buffer, vim } = fixture("")
  press(vim, "iab")
  vim.handleKey(key("escape"))
  assert.equal(buffer.text(), "ab")
  press(vim, ".")
  assert.equal(buffer.text(), "abab")
})

test(">> and << indent and dedent", () => {
  const { buffer, vim } = fixture("code\nmore")
  press(vim, ">>")
  assert.equal(buffer.text(), "  code\nmore")
  press(vim, "<<")
  assert.equal(buffer.text(), "code\nmore")
})

test("pasting inserts at the cursor in normal mode", () => {
  const { buffer, vim } = fixture("ab")
  vim.paste("XY")
  assert.equal(buffer.text(), "aXYb")
})

test("status reports mode, cursor and pending keys", () => {
  const { vim } = fixture("one\ntwo")
  assert.equal(vim.status().mode, "normal")
  assert.equal(vim.status().line, 1)
  press(vim, "j")
  assert.equal(vim.status().line, 2)
  press(vim, "3")
  assert.equal(vim.status().pending, "3")
  press(vim, "j")
  assert.equal(vim.status().pending, "")
  press(vim, "d")
  assert.equal(vim.status().pending, "d")
  press(vim, "d")
  assert.equal(vim.status().pending, "")
  press(vim, "i")
  assert.equal(vim.status().mode, "insert")
})

test("arrow keys, home/end and paging work in normal mode", () => {
  const { buffer, vim } = fixture("alpha\nbeta\ngamma\ndelta")
  vim.handleKey(key("down"))
  vim.handleKey(key("down"))
  assert.equal(buffer.cursor().row, 2)
  vim.handleKey(key("up"))
  assert.equal(buffer.cursor().row, 1)
  vim.handleKey(key("end"))
  assert.equal(buffer.cursor().col, 3)
  vim.handleKey(key("home"))
  assert.equal(buffer.cursor().col, 0)
  vim.handleKey(key("right"))
  assert.equal(buffer.cursor().col, 1)
  vim.handleKey(key("left"))
  assert.equal(buffer.cursor().col, 0)
  vim.handleKey(key("pagedown"))
  assert.equal(buffer.cursor().row, 3)
  vim.handleKey(key("pageup"))
  assert.equal(buffer.cursor().row, 0)
})

test("arrows extend a visual selection", () => {
  const { buffer, vim } = fixture("abc\ndef")
  press(vim, "v")
  vim.handleKey(key("down"))
  assert.deepEqual(buffer.selection?.start, { row: 0, col: 0 })
  assert.deepEqual(buffer.selection?.end, { row: 1, col: 1 })
})
