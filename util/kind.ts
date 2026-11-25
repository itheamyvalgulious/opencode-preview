// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * File kind detection and text decoding.
 *
 * Everything here is pure so it can be unit-tested; the viewers use the result
 * to pick an image, PDF or text surface.
 */

export type FileKind = "image" | "pdf" | "text" | "binary"

export type DetectedFile = {
  kind: FileKind
  /** Lower-case extension without the dot, when present. */
  extension: string
  /** Language id understood by the tree-sitter highlighter, when known. */
  filetype?: string
  /** Human-readable MIME-ish label for the viewer header. */
  label: string
  /** Why the file was treated as binary/text, for the header note. */
  note?: string
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  ico: "image/x-icon",
}

const EXTENSION_FILETYPES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  rst: "rst",
  tex: "latex",
  latex: "latex",
  bib: "bibtex",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  gitignore: "gitignore",
  diff: "diff",
  patch: "diff",
  txt: "text",
  log: "text",
  csv: "text",
  tsv: "text",
  env: "dotenv",
}

export function extensionOf(path: string): string {
  const base = path.replace(/[/\\]+$/, "")
  const name = base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) + 1)
  if (/^makefile$/i.test(name)) return "makefile"
  if (/^dockerfile$/i.test(name)) return "dockerfile"
  if (/^\.env/i.test(name)) return "env"
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/** Heuristic: printable UTF-8 text rather than binary data. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192)
  if (sample.includes(0)) return false
  let control = 0
  for (const byte of sample) {
    // Allow \t \n \r \f \v and printable ASCII / high bytes.
    if (byte === 9 || byte === 10 || byte === 12 || byte === 13) continue
    if (byte < 32) control++
  }
  if (sample.length > 0 && control / sample.length > 0.02) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample)
  } catch {
    // Not valid UTF-8: accept legacy single-byte encodings only if they are mostly text.
    return control === 0
  }
  return true
}

export function detectFile(path: string, bytes: Uint8Array): DetectedFile {
  const extension = extensionOf(path)
  if (IMAGE_EXTENSIONS[extension]) {
    return { kind: "image", extension, label: IMAGE_EXTENSIONS[extension]! }
  }
  if (extension === "pdf") return { kind: "pdf", extension, label: "application/pdf" }
  const filetype = EXTENSION_FILETYPES[extension]
  if (!looksLikeText(bytes)) {
    return { kind: "binary", extension, label: "binary", note: "not UTF-8 text; showing a read-only dump" }
  }
  return {
    kind: "text",
    extension,
    ...(filetype ? { filetype } : {}),
    label: filetype ?? (extension ? `${extension} text` : "text"),
  }
}

/** Decodes bytes as UTF-8, replacing invalid sequences rather than throwing. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("utf-8").decode(bytes)
  }
}

/** A printable hex dump for binary files (at most `limit` bytes). */
export function hexDump(bytes: Uint8Array, limit = 64 * 1024): string {
  const slice = bytes.subarray(0, limit)
  const lines: string[] = []
  for (let offset = 0; offset < slice.length; offset += 16) {
    const row = slice.subarray(offset, offset + 16)
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47)
    const ascii = [...row].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("")
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`)
  }
  if (bytes.length > limit) lines.push(`… ${bytes.length - limit} more bytes not shown`)
  return lines.join("\n")
}
