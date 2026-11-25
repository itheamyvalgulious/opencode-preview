// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * opencode-preview — TUI plugin
 *
 *   /preview <path>   render a file in a session panel (aliases: /show, /view)
 *   /preview          pick a file (fuzzy, server-indexed), then render it
 *
 * Images and PDFs render through the terminal's graphics protocol; PDFs are
 * rasterized on the TUI machine. Text files open in a built-in vim-style editor
 * (`:w` writes back through the server, so remote locations work too).
 *
 * The viewer lives in the `session.panel` slot; outside a session (`/preview` from
 * the home screen) the same viewer opens as a full-screen plugin route.
 */

import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid"
import { createElement, insert, setProp } from "@opentui/solid"
import { createSignal, onCleanup, untrack } from "solid-js"
import path from "node:path"
import { detectFile, decodeText, hexDump, type DetectedFile, type FileKind } from "./util/kind.ts"
import { basename, expandPath, formatBytes, isInside, relativeTo } from "./util/paths.ts"
import {
  isLocalDirectory,
  listLocalDirectory,
  localFileStamp,
  readLocalFile,
  writeLocalFile,
  type LocalEntry,
} from "./util/local.ts"
import { fuzzyScore } from "./util/fuzzy.ts"
import { isPdfSupported, pdfPageCount } from "./util/pdf.ts"
import { VimEditor } from "./vim/editor.ts"
import { ImageViewer, LoadingView, PdfViewer } from "./viewer/media.ts"

const PANEL = "preview.viewer"
const ROUTE = "preview"

type Node = ReturnType<typeof createElement>
const element = (tag: string, props: Record<string, unknown>, children: unknown[] = []): Node => {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value)
  }
  insert(node, children as never)
  return node
}
const text = (props: Record<string, unknown>, children: string[] = []) => element("text", props, children)

type Target = {
  /** Absolute path on the location's filesystem. */
  path: string
  display: string
  kind: FileKind
  filetype?: string
  label: string
  bytes: Uint8Array
  size: number
  pageCount?: number
  note?: string
  /** The source file ended with a newline; restored on write. */
  trailingNewline?: boolean
  /** Editor text (without the stripped trailing newline); binary files keep the hex dump here. */
  text?: string
}

type ViewerEntry = {
  target?: Target
  loading: boolean
  error?: string
  /** Current loading step, shown while a file is read/detected. */
  stage?: string
  /** When the current load started (epoch ms). */
  since?: number
}

type Choice =
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string }
  | { kind: "prompt" }
  | { kind: "root" }
  | { kind: "search" }

const isHttp = (value: string) => /^https?:\/\//i.test(value)

export default Plugin.define({
  id: "preview",
  setup(context: Context) {
    const root = () => context.location?.directory ?? process.cwd()
    const [viewers, setViewers] = createSignal<Record<string, ViewerEntry>>({}, { equals: false })

    const update = (key: string, entry: ViewerEntry) => {
      setViewers((current) => ({ ...current, [key]: entry }))
    }
    const stage = (key: string, name: string) => {
      setViewers((current) => {
        const entry = current[key]
        if (!entry) return current
        return { ...current, [key]: { ...entry, loading: true, stage: name } }
      })
    }

    /** Resolves a user-supplied path: `~`, absolute, or relative to the session root. */
    const resolveSpec = (spec: string): string => {
      const expanded = expandPath(spec)
      return path.isAbsolute(expanded) ? expanded : path.resolve(root(), expanded)
    }

    const serverPath = (absolute: string) => relativeTo(root(), absolute)

    // ── Loading ───────────────────────────────────────────────────────────

    const outside = (absolute: string) => !isInside(root(), absolute)

    // Files outside the session are read from disk. Cloud/FUSE mounts can take
    // seconds per read, so recent bytes are kept keyed by path+size+mtime.
    const DISK_CACHE_LIMIT = 32 * 1024 * 1024
    const diskCache = new Map<string, Uint8Array>()
    let diskCacheBytes = 0
    const cachedRead = async (absolute: string, onStage?: (name: string) => void): Promise<Uint8Array> => {
      onStage?.("stat")
      const stamp = localFileStamp(absolute)
      if (!stamp) {
        throw new Error(
          `${relativeTo(root(), absolute)} is outside the session directory and unreadable on this machine`,
        )
      }
      const key = `${absolute}|${stamp.size}|${stamp.mtimeMs}`
      const hit = diskCache.get(key)
      if (hit) {
        onStage?.("cache hit")
        // Refresh LRU order.
        diskCache.delete(key)
        diskCache.set(key, hit)
        return hit
      }
      onStage?.("reading file")
      const bytes = await readLocalFile(absolute)
      if (bytes.byteLength <= 8 * 1024 * 1024) {
        diskCache.set(key, bytes)
        diskCacheBytes += bytes.byteLength
        while (diskCacheBytes > DISK_CACHE_LIMIT) {
          const oldest = diskCache.keys().next().value as string | undefined
          if (!oldest) break
          diskCacheBytes -= diskCache.get(oldest)?.byteLength ?? 0
          diskCache.delete(oldest)
        }
      }
      return bytes
    }

    /** Reads through the server inside the session, from disk outside it. */
    const readBytes = async (absolute: string, onStage?: (name: string) => void): Promise<Uint8Array> => {
      if (outside(absolute)) return cachedRead(absolute, onStage)
      return context.client.file.read({ path: serverPath(absolute), location: context.location })
    }

    const targetOf = async (absolute: string, onStage?: (name: string) => void): Promise<Target> => {
      const bytes = await readBytes(absolute, onStage)
      onStage?.("detecting")
      const detected: DetectedFile = detectFile(absolute, bytes)
      const decoded = detected.kind === "binary" ? undefined : decodeText(bytes)
      const target: Target = {
        path: absolute,
        display: relativeTo(root(), absolute),
        kind: detected.kind,
        filetype: detected.filetype,
        label: detected.label,
        bytes,
        size: bytes.byteLength,
        note: detected.note,
        // A single trailing newline is not shown as a phantom empty line.
        ...(decoded !== undefined && decoded.endsWith("\n") ? { trailingNewline: true } : {}),
        text:
          decoded === undefined
            ? undefined
            : decoded.endsWith("\n")
              ? decoded.slice(0, -1)
              : decoded,
      }
      if (detected.kind === "pdf") {
        if (!isPdfSupported()) target.note = "no PDF renderer installed (poppler-utils / mupdf-tools / ghostscript)"
        onStage?.("reading PDF info")
        target.pageCount = await pdfPageCount(bytes)
      }
      return target
    }

    const loadInto = async (key: string, spec: string) => {
      update(key, { loading: true, since: Date.now(), stage: "reading" })
      try {
        if (isHttp(spec)) throw new Error("URLs are not supported by /preview yet")
        const target = await targetOf(resolveSpec(spec), (name) => stage(key, name))
        update(key, { target, loading: false, stage: undefined })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        update(key, { loading: false, error: message })
        context.ui.toast.show({ title: "/preview", message, variant: "error" })
      }
    }

    const isDirectoryPath = async (absolute: string): Promise<boolean> => {
      if (isLocalDirectory(absolute)) return true
      if (outside(absolute)) return false
      try {
        await context.client.file.list({ location: context.location, path: serverPath(absolute) })
        return true
      } catch {
        return false
      }
    }

    /** Shows one already-resolved file in the active session panel (or the plugin route). */
    const openFile = (absolute: string) => {
      const key = `route:${Date.now()}`
      const route = context.ui.router.current()
      if (route.type === "session") {
        update(route.sessionID, { loading: true, since: Date.now(), stage: "reading" })
        void loadInto(route.sessionID, absolute)
        if (context.ui.panel.open(PANEL, { presentation: "panel" })) return
      }
      update(key, { loading: true, since: Date.now(), stage: "reading" })
      void loadInto(key, absolute)
      context.ui.router.navigate({ type: "plugin", name: ROUTE, data: { key } })
    }

    /** `/preview <spec>`: a directory opens the picker at that directory, a file is shown. */
    const openSpec = async (spec: string) => {
      const absolute = resolveSpec(spec)
      if (await isDirectoryPath(absolute)) await openPicker(absolute)
      else openFile(absolute)
    }

    // ── Picker ────────────────────────────────────────────────────────────

    type SelectOption = {
      title: string
      value: Choice
      description?: string
      category?: string
    }

    /** One directory level: through the server inside the session, from disk outside it. */
    const listEntries = async (directory: string): Promise<LocalEntry[]> => {
      if (isInside(root(), directory)) {
        try {
          const response = await context.client.file.list({
            location: context.location,
            ...(directory === root() ? {} : { path: relativeTo(root(), directory) }),
          })
          return response.data.map((entry) => ({ path: path.resolve(root(), entry.path), type: entry.type }))
        } catch {
          return []
        }
      }
      return listLocalDirectory(directory)
    }

    const projectFiles = async (query: string, limit = 200): Promise<LocalEntry[]> => {
      try {
        const response = await context.client.file.find({
          location: context.location,
          query,
          type: "file",
          limit,
        })
        return response.data.map((entry) => ({ path: path.resolve(root(), entry.path), type: "file" as const }))
      } catch {
        return []
      }
    }

    const fileOptions = (entries: LocalEntry[]): SelectOption[] => [
      ...entries
        .filter((entry) => entry.type === "directory")
        .map((entry) => ({
          title: `${basename(entry.path)}/`,
          value: { kind: "dir", path: entry.path } as Choice,
          category: "Folders",
          ...(outside(entry.path) ? { description: entry.path } : {}),
        })),
      ...entries
        .filter((entry) => entry.type === "file")
        .map((entry) => ({
          title: basename(entry.path),
          value: { kind: "file", path: entry.path } as Choice,
          category: "Files",
          ...(outside(entry.path) ? { description: entry.path } : {}),
        })),
    ]

    const pick = async (directory: string): Promise<Choice | undefined> => {
      const listed = await listEntries(directory)
      const atRoot = directory === root()
      const options: SelectOption[] = [
        {
          title: "Enter a path…",
          value: { kind: "prompt" },
          category: "Actions",
          description: "relative to the session, absolute, or ~/…",
        },
        {
          title: "Search project…",
          value: { kind: "search" },
          category: "Actions",
          description: "fuzzy search every indexed file (slower)",
        },
        ...(atRoot
          ? []
          : [
              { title: "..", value: { kind: "dir", path: path.dirname(directory) } as Choice, category: "Actions" },
              { title: "Session root", value: { kind: "root" } as Choice, category: "Actions", description: root() },
            ]),
        ...fileOptions(listed),
      ]

      const label = directory === root() ? "." : relativeTo(root(), directory)
      return context.ui.dialog.select<Choice>({
        title: `Open file — ${label}`,
        placeholder: "type to filter this folder…",
        options,
        search: (query, all) => {
          if (!query.trim()) return all
          return all
            .map((option) => ({ option, score: fuzzyScore(query.trim(), `${option.title} ${option.description ?? ""}`) }))
            .filter((item) => item.score >= 0)
            .sort((left, right) => right.score - left.score)
            .map((item) => item.option)
        },
      })
    }

    const openPicker = async (start?: string) => {
      let directory = start ?? root()
      for (;;) {
        const choice = await pick(directory)
        if (!choice) return
        if (choice.kind === "file") return openFile(choice.path)
        if (choice.kind === "dir") {
          directory = choice.path
          continue
        }
        if (choice.kind === "root") {
          directory = root()
          continue
        }
        if (choice.kind === "search") {
          const query = await context.ui.dialog.prompt({
            title: "Search project files",
            placeholder: "report",
          })
          if (query === undefined) continue
          const wait = setTimeout(
            () => context.ui.toast.show({ message: "searching indexed files…", variant: "info" }),
            400,
          )
          const found = await projectFiles(query)
          clearTimeout(wait)
          if (found.length === 0) {
            context.ui.toast.show({ message: `no files match “${query}”`, variant: "warning" })
            continue
          }
          const picked = await context.ui.dialog.select<Choice>({
            title: `Search — ${query}`,
            options: found.map((entry) => ({
              title: basename(entry.path),
              value: { kind: "file", path: entry.path } as Choice,
              category: "Project",
              description: relativeTo(root(), entry.path),
            })),
            search: (value, all) => {
              if (!value.trim()) return all
              return all
                .map((option) => ({ option, score: fuzzyScore(value.trim(), `${option.title} ${option.description ?? ""}`) }))
                .filter((item) => item.score >= 0)
                .sort((left, right) => right.score - left.score)
                .map((item) => item.option)
            },
          })
          if (picked && picked.kind === "file") return openFile(picked.path)
          continue
        }
        const typed = await context.ui.dialog.prompt({
          title: "Open file",
          description: "relative to the session directory, absolute, or ~/…",
          placeholder: "src/index.ts",
        })
        if (!typed?.trim()) continue
        return openSpec(typed.trim())
      }
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    const save = async (absolute: string, next: string, trailingNewline = false): Promise<string> => {
      const text = trailingNewline && !next.endsWith("\n") ? `${next}\n` : next
      const payload = new TextEncoder().encode(text)
      if (outside(absolute)) {
        await writeLocalFile(absolute, payload)
        return absolute
      }
      const response = await context.client.file.write({
        path: serverPath(absolute),
        payload,
        location: context.location,
      })
      return (response as { data?: { path?: string } })?.data?.path ?? serverPath(absolute)
    }

    const viewer = (
      key: string,
      input: { close: () => void; fullscreen: () => void },
    ): JSX.Element => {
      const entry = viewers()[key]
      if (!entry || entry.loading) {
        return LoadingView({
          context,
          label: entry?.stage ? `${entry.stage}…` : "loading…",
          since: entry?.since ?? Date.now(),
          onClose: input.close,
        })
      }
      if (!entry.target) {
        return text({ fg: context.theme.text.feedback.error.base, paddingLeft: 1, wrapMode: "word" }, [
          entry.error ?? "could not open file",
        ]) as unknown as JSX.Element
      }
      const target = entry.target
      const title = basename(target.path)
      if (target.kind === "image") {
        return ImageViewer({
          context,
          bytes: target.bytes,
          title,
          subtitle: `${formatBytes(target.size)} · ${target.label}`,
          onClose: input.close,
          onFullscreen: input.fullscreen,
        })
      }
      if (target.kind === "pdf") {
        if (!isPdfSupported()) {
          return text({ fg: context.theme.text.feedback.warning.base, paddingLeft: 1, wrapMode: "word" }, [
            target.note ?? "no PDF renderer installed",
          ]) as unknown as JSX.Element
        }
        return PdfViewer({
          context,
          bytes: target.bytes,
          title,
          pageCount: target.pageCount,
          onClose: input.close,
          onFullscreen: input.fullscreen,
        })
      }
      const content = target.kind === "binary" ? hexDump(target.bytes) : (target.text ?? decodeText(target.bytes))
      return VimEditor({
        context,
        path: target.path,
        displayPath: target.display,
        content,
        filetype: target.filetype,
        bytes: target.size,
        readOnly: target.kind === "binary",
        onClose: input.close,
        onOpen: (spec) => void loadInto(key, spec),
        onSave: async (next, destination) => {
          const absolute = destination ? resolveSpec(destination) : target.path
          await save(absolute, next, target.trailingNewline === true)
          if (absolute !== target.path) update(key, { target: await targetOf(absolute), loading: false })
        },
      })
    }

    // The slot/route render re-runs when the loaded entry changes (that is how
    // the panel updates), and Solid disposes the previous node's owners on that
    // re-run. A rebuilt node must therefore be used, never the disposed one —
    // `isDestroyed` does not reflect owner disposal, so disposal is tracked
    // explicitly.
    //
    // `build()` MUST run untracked: the host wraps this render callback in a
    // reactive scope, so every signal a viewer reads during construction
    // (busy/page/zoom in PdfViewer, now in LoadingView, vim state in the
    // editor) is captured as a scope dependency. The viewer then writes those
    // signals, invalidates the scope, gets disposed and rebuilt — forever,
    // burning ~100 MB/s in dead subtrees. Reading `viewers()[key]` stays
    // tracked on purpose: an entry change still re-invokes the render.
    const mounted = new Map<string, { entry: ViewerEntry | undefined; node: Node; alive: boolean }>()
    const remember = (key: string, build: () => JSX.Element): JSX.Element => {
      const entry = viewers()[key]
      const cached = mounted.get(key)
      const destroyed = (cached?.node as unknown as { isDestroyed?: boolean } | undefined)?.isDestroyed === true
      if (cached?.alive && !destroyed && cached.entry === entry) return cached.node as unknown as JSX.Element
      const node = untrack(() => build()) as unknown as Node
      const record = { entry, node, alive: true }
      mounted.set(key, record)
      onCleanup(() => {
        record.alive = false
      })
      return node as unknown as JSX.Element
    }

    context.ui.slot({
      append: "session.panel",
      render: (panel: PanelInput) => {
        if (panel.name !== PANEL) return text({}, [""]) as unknown as JSX.Element
        return remember(panel.sessionID, () =>
          viewer(panel.sessionID, {
            close: () => panel.close(),
            fullscreen: () => panel.toggleFullscreen(),
          }),
        )
      },
    })

    context.ui.router.register({
      name: ROUTE,
      render: ({ data }) => {
        const key = String(data?.key ?? "")
        return remember(key, () =>
          viewer(key, {
            close: () => context.ui.router.navigate({ type: "home" }),
            fullscreen: () => undefined,
          }),
        )
      },
    })

    // ── Commands ──────────────────────────────────────────────────────────

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "preview.open",
          title: "Preview file",
          description: "Render an image, PDF or text file in the terminal",
          group: "View",
          palette: true,
          slash: { name: "preview", aliases: ["show", "view"], arguments: true },
          run: (input) => {
            const spec = (input ?? "").trim()
            if (!spec) return void openPicker()
            void openSpec(spec)
          },
        },
        {
          id: "preview.picker",
          title: "Preview a file…",
          group: "View",
          run: () => void openPicker(),
        },
      ],
    }))

    return () => {
      setViewers({})
    }
  },
})
