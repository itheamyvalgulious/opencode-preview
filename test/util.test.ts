// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict"
import { test } from "node:test"
import { detectFile, decodeText, extensionOf, hexDump, looksLikeText } from "../util/kind.ts"
import { basename, expandPath, formatBytes, isInside, relativeTo } from "../util/paths.ts"
import { listLocalDirectory, readLocalFile, writeLocalFile } from "../util/local.ts"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import os from "node:os"
import pathmod from "node:path"
import { fuzzyScore } from "../util/fuzzy.ts"

const bytes = (value: string) => new TextEncoder().encode(value)

test("extensions: dotted, uppercase, dotfiles and named files", () => {
  assert.equal(extensionOf("/tmp/a/README.MD"), "md")
  assert.equal(extensionOf("archive.tar.gz"), "gz")
  assert.equal(extensionOf("Makefile"), "makefile")
  assert.equal(extensionOf("Dockerfile"), "dockerfile")
  assert.equal(extensionOf(".env.local"), "env")
  assert.equal(extensionOf("noext"), "")
})

test("detectFile classifies images, pdf, text and binary", () => {
  assert.equal(detectFile("a.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])).kind, "image")
  assert.equal(detectFile("a.PDF", bytes("%PDF-1.7")).kind, "pdf")
  const source = detectFile("a.ts", bytes("const a = 1\n"))
  assert.equal(source.kind, "text")
  assert.equal(source.filetype, "typescript")
  assert.equal(detectFile("blob.bin", new Uint8Array([0, 1, 2, 3])).kind, "binary")
  assert.equal(detectFile("run.sh", bytes("#!/bin/sh\necho hi\n")).filetype, "bash")
})

test("looksLikeText rejects NUL bytes and accepts UTF-8", () => {
  assert.equal(looksLikeText(bytes("héllo wörld")), true)
  assert.equal(looksLikeText(new Uint8Array([0x68, 0x00, 0x69])), false)
})

test("decodeText round-trips UTF-8 and replaces invalid bytes", () => {
  assert.equal(decodeText(bytes("你好")), "你好")
  assert.ok(decodeText(new Uint8Array([0xff, 0xfe, 0x41])).includes("A"))
})

test("hexDump renders offsets, hex and ascii", () => {
  const dump = hexDump(bytes("ABC"))
  assert.match(dump, /^00000000 {2}41 42 43/)
  assert.match(dump, /ABC$/)
})

test("paths: expansion, relativisation and sizes", () => {
  const home = "/home/tester"
  assert.equal(expandPath("~/notes.txt", home), "/home/tester/notes.txt")
  assert.equal(expandPath("/etc/hosts", home), "/etc/hosts")
  assert.equal(relativeTo("/work/app", "/work/app/src/a.ts"), "src/a.ts")
  assert.equal(relativeTo("/work/app", "/etc/hosts"), "/etc/hosts")
  assert.equal(basename("/work/app/src/a.ts"), "a.ts")
  assert.equal(formatBytes(512), "512 B")
  assert.equal(formatBytes(2048), "2.0 KB")
})

test("fuzzyScore ranks contiguous and path-boundary matches higher", () => {
  assert.equal(fuzzyScore("zzz", "src/app.ts"), -1)
  const contiguous = fuzzyScore("app", "src/app.ts")
  const scattered = fuzzyScore("app", "a/p/p.ts")
  assert.ok(contiguous > scattered)
  assert.ok(fuzzyScore("", "anything") === 0)
})

test("isInside distinguishes the session directory from outside paths", () => {
  assert.equal(isInside("/work/app", "/work/app"), true)
  assert.equal(isInside("/work/app", "/work/app/src/a.ts"), true)
  assert.equal(isInside("/work/app", "/work/apple/a.ts"), false)
  assert.equal(isInside("/work/app", "/etc/hosts"), false)
  assert.equal(isInside("/work/app", "/work/app/../other/a.ts"), false)
})

test("local files: read, write and one-level listing", async () => {
  const dir = await mkdtemp(pathmod.join(os.tmpdir(), "preview-local-"))
  await mkdir(pathmod.join(dir, "sub"))
  await writeFile(pathmod.join(dir, "b.txt"), "hi")
  await writeFile(pathmod.join(dir, "a.txt"), "yo")
  await mkdir(pathmod.join(dir, "node_modules"))
  const entries = await listLocalDirectory(dir)
  assert.deepEqual(entries.map((entry) => [pathmod.basename(entry.path), entry.type]), [
    ["sub", "directory"],
    ["a.txt", "file"],
    ["b.txt", "file"],
  ])
  await writeLocalFile(pathmod.join(dir, "sub", "out.txt"), new TextEncoder().encode("written"))
  assert.equal(await readFile(pathmod.join(dir, "sub", "out.txt"), "utf8"), "written")
  assert.equal(new TextDecoder().decode(await readLocalFile(pathmod.join(dir, "a.txt"))), "yo")
})
