// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Local filesystem access for paths outside the session directory.
 *
 * The OpenCode server's file API is confined to the location directory, so a
 * path like `~/cloud/report.pdf` cannot be read through it. When the TUI runs
 * on the same machine, such paths are read (and written) directly instead.
 *
 * Reads and writes are deliberately NOT done through `node:fs/promises` or
 * `Bun.file`: inside the TUI's Bun runtime, an async `fs.promises.readFile`
 * targeting an rclone/FUSE mount can wedge in native code — it never resolves
 * and leaks anonymous memory at ~100 MB/s until the process dies, while the
 * UI shows "reading file…" forever. Async process spawns (`Bun.spawn`,
 * `execFile`) stall the same way. The reliable primitives here are:
 *
 *  - a `Worker` running `readFileSync`/`writeFileSync` on a real thread — the
 *    event loop stays alive and `q` can cancel the view while the cloud
 *    mount takes its time
 *  - a bounded `cat` subprocess (`spawnSync`, timeout + SIGKILL)
 *  - a bare `readFileSync`/`writeFileSync` as the last resort
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    if (typeof timer === "object" && timer) (timer as { unref?: () => void }).unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// ── Worker-based file I/O ────────────────────────────────────────────────

/**
 * Inline worker script (loaded via a data: URL so no extra file ships).
 * Synchronous fs calls are fine here: blocking the worker thread does not
 * freeze the TUI, and sync primitives work on FUSE mounts where the async
 * implementations stall inside this runtime.
 */
const WORKER_SOURCE = `
const { readdirSync, readFileSync, writeFileSync } = require("node:fs")
self.onmessage = (e) => {
  const { op, target, bytes } = e.data
  try {
    if (op === "write") {
      writeFileSync(target, bytes)
      self.postMessage({ ok: true })
    } else if (op === "list") {
      const entries = readdirSync(target, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
      }))
      self.postMessage({ ok: true, entries })
    } else {
      self.postMessage({ ok: true, bytes: readFileSync(target) })
    }
  } catch (error) {
    self.postMessage({ ok: false, error: String((error && error.message) || error) })
  }
}
`

type WorkerResult = { ok: boolean; bytes?: Uint8Array; entries?: Array<{ name: string; dir: boolean }>; error?: string }

/**
 * Runs one synchronous fs op on a worker thread. Resolves with the operation
 * result. Rejects on worker error, fs error, or the watchdog timeout — after
 * which the worker is terminated.
 */
async function runFsWorker(op: "read" | "write" | "list", target: string, bytes: Uint8Array | undefined, timeoutMs: number): Promise<WorkerResult> {
  const worker = new Worker(`data:text/typescript,${encodeURIComponent(WORKER_SOURCE)}`)
  try {
    const request = new Promise<WorkerResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent) => resolve(event.data as WorkerResult)
      worker.onerror = (event: { message?: string }) => reject(new Error(event?.message ?? "worker failed"))
      worker.postMessage({ op, target, bytes })
    })
    const result = await withTimeout(request, timeoutMs, () => new Error(`${op} ${target} timed out`))
    if (!result.ok) throw new Error(result.error ?? `${op} ${target} failed`)
    return result
  } finally {
    try {
      worker.terminate()
    } catch {
      // Termination is best effort; a wedged worker thread is still bounded.
    }
  }
}

/** Bounded `cat` subprocess: the kernel streams the file out, no runtime fs code involved. */
function spawnCat(target: string, timeoutMs = 30_000): Uint8Array {
  const bun = (globalThis as { Bun?: { spawnSync?: unknown } }).Bun
  if (bun?.spawnSync) {
    const spawnSync = bun.spawnSync as (options: Record<string, unknown>) => {
      success?: boolean
      stdout?: Uint8Array | string
    }
    const result = spawnSync({
      cmd: ["cat", target],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    })
    if (result.success && result.stdout instanceof Uint8Array) return result.stdout
    throw new Error(`cat ${target} failed`)
  }
  const output = execFileSync("cat", [target], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 1024,
  })
  return new Uint8Array(output)
}

/**
 * Reads a local file without blocking the event loop and without tripping the
 * runtime's broken async-fs path on FUSE mounts. Worker thread first
 * (non-blocking, cancelable), a bounded `cat` subprocess next, and a bare
 * `readFileSync` as the last resort.
 */
export async function readBytes(target: string, timeoutMs = 60_000): Promise<Uint8Array> {
  try {
    const result = await runFsWorker("read", target, undefined, timeoutMs)
    if (result.bytes) return new Uint8Array(result.bytes)
  } catch {
    // Worker unavailable or wedged — fall through to the subprocess path.
  }
  try {
    return spawnCat(target, Math.min(timeoutMs, 30_000))
  } catch {
    return new Uint8Array(readFileSync(target))
  }
}

export async function writeBytes(target: string, bytes: Uint8Array): Promise<void> {
  mkdirSync(path.dirname(target), { recursive: true })
  try {
    await runFsWorker("write", target, bytes, 60_000)
    return
  } catch {
    writeFileSync(target, bytes)
  }
}

export type LocalEntry = { path: string; type: "file" | "directory" }

export const isLocalFile = (target: string): boolean => {
  try {
    return existsSync(target) && statSync(target).isFile()
  } catch {
    return false
  }
}

export const isLocalDirectory = (target: string): boolean => {
  try {
    return existsSync(target) && statSync(target).isDirectory()
  } catch {
    return false
  }
}

export const readLocalFile = (target: string): Promise<Uint8Array> => readBytes(target)

/** Cheap identity for cache keys; `stat` is immediate even on FUSE mounts. */
export function localFileStamp(target: string): { size: number; mtimeMs: number } | undefined {
  try {
    const info = statSync(target)
    if (!info.isFile()) return undefined
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return undefined
  }
}

export const writeLocalFile = (target: string, bytes: Uint8Array): Promise<void> => writeBytes(target, bytes)

const SKIP = new Set(["node_modules", ".git", ".hg", ".svn"])

/** One directory level, directories first, like `ls`. */
export async function listLocalDirectory(directory: string, limit = 400): Promise<LocalEntry[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    const result = await runFsWorker("list", directory, undefined, 20_000)
    entries = (result.entries ?? []).map((entry) => ({
      name: entry.name,
      isDirectory: () => entry.dir,
    }))
  } catch {
    try {
      // Worker listing failed or wedged (some fs paths are unreliable in the
      // TUI runtime); the synchronous variant is the fallback.
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return []
    }
  }
  const visible = entries.filter((entry) => !SKIP.has(entry.name)).slice(0, limit)
  const sorted = visible.sort((left, right) => {
    const leftDir = left.isDirectory()
    const rightDir = right.isDirectory()
    if (leftDir !== rightDir) return leftDir ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  return sorted.map((entry) => ({
    path: path.join(directory, entry.name),
    type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
  }))
}
