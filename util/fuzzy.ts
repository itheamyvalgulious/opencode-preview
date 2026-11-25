// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * A tiny subsequence matcher for the file picker: contiguous runs, word
 * boundaries and shorter paths score higher. Returns -1 when `query` is not a
 * subsequence of `value`.
 */
export function fuzzyScore(query: string, value: string): number {
  if (!query) return 0
  const target = value.toLowerCase()
  const needle = query.toLowerCase()
  let score = 0
  let index = 0
  let run = 0
  for (const ch of needle) {
    const at = target.indexOf(ch, index)
    if (at < 0) return -1
    score += 1
    if (at === index) {
      run += 1
      score += run * 2
    } else {
      // Gaps are penalized so scattered matches rank below contiguous ones.
      run = 0
      score -= (at - index) * 0.5
    }
    if (at === 0 || /[/\\._-]/.test(target[at - 1] ?? "")) score += 1
    index = at + 1
  }
  return score - (target.length - needle.length) * 0.01
}
