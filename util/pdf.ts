// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * PDF rasterization for the terminal viewer.
 *
 * PDFs are rendered to PNG on the machine running the TUI (the bytes come from
 * the OpenCode server, so a remote server works too), then handed to the
 * terminal image renderer. Renderers are probed in order:
 *   pdftoppm (poppler) → mutool (mupdf-tools) → gs (ghostscript)
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readBytes, writeBytes } from "./local.ts"

/**
 * Synchronous variant for rasterization.
 *
 * Async `Bun.spawn` resolves for `pdfinfo` but its `exited` promise never
 * settles for `pdftoppm` inside the TUI runtime, which left the viewer on
 * "rendering…" forever. Rasterizing a page takes ~0.1-1 s, so running it
 * synchronously (with a hard timeout) is both fast and dependable.
 */
function runSync(command: string, args: string[], options: { captureStdout?: boolean; timeoutMs?: number } = {}): string {
  const timeoutMs = options.timeoutMs ?? 15_000
  const captureStdout = options.captureStdout ?? false
  const bun = (globalThis as { Bun?: { spawnSync?: unknown } }).Bun
  if (bun?.spawnSync) {
    const spawnSync = bun.spawnSync as (options: Record<string, unknown>) => {
      success?: boolean
      exitCode?: number
      stdout?: Uint8Array | string
      stderr?: Uint8Array | string
    }
    const result = spawnSync({
      cmd: [command, ...args],
      stdin: "ignore",
      stdout: captureStdout ? "pipe" : "ignore",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    })
    const stdout =
      captureStdout && result.stdout instanceof Uint8Array ? new TextDecoder().decode(result.stdout) : ""
    if (result.success) return stdout
    const stderr =
      result.stderr instanceof Uint8Array ? new TextDecoder().decode(result.stderr) : String(result.stderr ?? "")
    throw new Error(`${command} exited with ${result.exitCode ?? "?"}: ${stderr.trim().slice(0, 300)}`)
  }
  const output = execFileSync(command, args, {
    stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
  })
  return captureStdout ? String(output ?? "") : ""
}

export type PdfRenderer = "pdftoppm" | "mutool" | "gs"

let cachedRenderer: PdfRenderer | null | undefined

const inPath = (binary: string): boolean => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  return dirs.some((dir) => existsSync(path.join(dir, binary)))
}

/** The first available rasterizer, or null when none is installed. */
export function pdfRenderer(): PdfRenderer | null {
  if (cachedRenderer !== undefined) return cachedRenderer
  cachedRenderer = inPath("pdftoppm") ? "pdftoppm" : inPath("mutool") ? "mutool" : inPath("gs") ? "gs" : null
  return cachedRenderer
}

export function pdfInfoAvailable(): boolean {
  return inPath("pdfinfo")
}

export const isPdfSupported = () => pdfRenderer() !== null

function cacheDirectory(): string {
  return path.join(os.tmpdir(), "opencode-preview", "pdf")
}

async function materialize(bytes: Uint8Array): Promise<string> {
  const hash = createHash("sha1").update(bytes).digest("hex")
  const directory = cacheDirectory()
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${hash}.pdf`)
  if (!existsSync(file)) await writeBytes(file, bytes)
  return file
}

/** Page count when `pdfinfo` is available and agrees, else undefined. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | undefined> {
  if (!pdfInfoAvailable()) return undefined
  try {
    const file = await materialize(bytes)
    const stdout = runSync("pdfinfo", [file], { captureStdout: true })
    const match = /^Pages:\s+(\d+)/m.exec(stdout)
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

const pageCache = new Map<string, Uint8Array>()
// Rasterized pages are large; keep the cache bounded (~8 pages).
const PAGE_CACHE_LIMIT = 8 * 1024 * 1024
let pageCacheBytes = 0

/**
 * Rasterizes one 1-based page to PNG bytes. Results are cached per content,
 * page and resolution.
 */
export async function renderPdfPage(
  bytes: Uint8Array,
  page: number,
  dpi: number,
  progress?: (stage: string) => void,
): Promise<Uint8Array> {
  progress?.("hashing")
  const key = `${createHash("sha1").update(bytes).digest("hex")}:${page}:${dpi}`
  const cached = pageCache.get(key)
  if (cached) {
    // LRU: most recently used last.
    pageCache.delete(key)
    pageCache.set(key, cached)
    return cached
  }

  const renderer = pdfRenderer()
  if (!renderer) throw new Error("No PDF renderer found (install poppler-utils, mupdf-tools or ghostscript)")

  progress?.("copying")
  const file = await materialize(bytes)
  const directory = cacheDirectory()
  const output = path.join(directory, `${key.replaceAll(":", "-")}.png`)
  try {
    rmSync(output, { force: true })
  } catch {
    // Nothing to remove.
  }
  progress?.(`rasterizing (${renderer})`)

  if (renderer === "pdftoppm") {
    runSync("pdftoppm", [
      "-q",
      "-png",
      "-r",
      String(dpi),
      "-f",
      String(page),
      "-l",
      String(page),
      "-singlefile",
      file,
      output.slice(0, -4),
    ])
  } else if (renderer === "mutool") {
    runSync("mutool", ["draw", "-q", "-r", String(dpi), "-o", output, file, String(page)])
  } else {
    runSync("gs", [
      "-q",
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      "-sDEVICE=png16m",
      `-r${dpi}`,
      `-dFirstPage=${page}`,
      `-dLastPage=${page}`,
      `-sOutputFile=${output}`,
      file,
    ])
  }

  progress?.("reading png")
  // The PNG was just written by the rasterizer into a local temp dir; a short
  // timeout keeps a stalled read bounded before the sync fallback kicks in.
  const png = await readBytes(output, 3_000)
  // Keep a small window: pages are re-rendered cheaply and the cache must not grow without bound.
  if (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value!)
  pageCache.set(key, png)
  pageCacheBytes += png.byteLength
  while (pageCacheBytes > PAGE_CACHE_LIMIT) {
    const oldest = pageCache.keys().next().value as string | undefined
    if (oldest === undefined || oldest === key) break
    pageCacheBytes -= pageCache.get(oldest)?.byteLength ?? 0
    pageCache.delete(oldest)
  }
  try {
    rmSync(output, { force: true })
  } catch {
    // Best effort.
  }
  return png
}
