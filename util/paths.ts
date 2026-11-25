// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import path from "node:path"

/** Expands a leading `~` and returns an absolute path. */
export function expandPath(input: string, home = process.env.HOME ?? ""): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2)) : trimmed
  return path.resolve(expanded)
}

/** Path relative to `root` when it is inside it, otherwise the input as-is. */
export function relativeTo(root: string | undefined, absolute: string): string {
  if (!root) return absolute
  const relative = path.relative(root, absolute)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return absolute
  return relative
}

/** True when `absolute` is `root` itself or below it. */
export function isInside(root: string | undefined, absolute: string): boolean {
  if (!root) return false
  const relative = path.relative(root, absolute)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** A compact `1.2 MB` style size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** The trailing path segment. */
export function basename(target: string): string {
  const trimmed = target.replace(/[/\\]+$/, "")
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}
