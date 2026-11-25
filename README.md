# opencode-preview

Render any file in the OpenCode terminal UI.

```
/preview <path>     render a file
/preview            pick a file, then render it
```

`/show` and `/view` are aliases of `/preview`.

- **Images** — PNG, JPEG, GIF, WebP, BMP, TIFF, AVIF, ICO. Drawn with the
  terminal's native graphics protocol (kitty / sixel) and a block fallback when
  the terminal has neither.
- **PDFs** — rasterized to PNG on the machine running the TUI, one page at a
  time, with page navigation and zoom. The first page is rendered at a
  resolution matched to the terminal (≈50–70 dpi, ~0.1 s for a two-page
  document); `+` raises it when you want more detail. The header reports how
  long the page took
- **Text** — a built-in vim-style editor (`NORMAL` / `INSERT` / `VISUAL`),
  tree-sitter highlighting, `:w` writes back through the OpenCode server.
- **Anything else** — a read-only hex dump.

Everything is read through the OpenCode server's file API, so it works when the
TUI is connected to a remote server. Writes (`:w`) go through the server too.

## Install

Add the directory to `plugins` in `opencode.json` (global or project):

```json
{
  "plugins": ["/path/to/opencode-preview"]
}
```

OpenCode loads the package's server part (`./index.ts`, empty) and its TUI part
(`./tui.ts`). The server part is required: the TUI only loads the `tui`
entrypoint of plugins the server activated.

## Usage

`/preview <path>` opens the viewer in a docked side panel (or full screen on a
narrow terminal). From the home screen it opens as a full-screen page.

- `path` is resolved relative to the session directory; `~` and absolute paths
  work too.
- If `path` is a **directory**, the file picker opens at that directory.
- `/preview` with no argument opens the picker at the session directory. It lists
  **one directory level** (a single `ls`), so it appears immediately; pick
  "Search project…" only when you want the server's global fuzzy index.
- Paths **outside** the session directory cannot go through the server's file
  API, so they are read/written directly from disk when the TUI runs on the
  same machine. Cloud/FUSE mounts (rclone, gvfs, …) can take seconds for the
  first read; the panel shows the current step and a live timer, and decoded
  bytes are cached in memory (by path + size + mtime) so re-opening is instant.
- The palette command **Preview file** does the same and also works while the agent
  is running; a slash command is refused by the host during a turn ("this prompt
  cannot be queued").

### Viewer keys

| Key | Text | Image / PDF |
| --- | --- | --- |
| `q` / `Esc` | close (prompts when modified) | close |
| `f` | — | toggle fullscreen |
| `j` / `k`, `↓` / `↑` | down / up | next / previous page |
| `PgDn` / `PgUp`, `Space` (media) | full page | next / previous page |
| `Ctrl+d` / `Ctrl+u` | half page | — |
| `Ctrl+f` / `Ctrl+b` | full page | — |
| `+` / `-` / `z` | — | zoom in / out (higher dpi = sharper, larger upload) |

### Vim editor

| Group | Keys |
| --- | --- |
| Modes | `i` `a` `I` `A` `o` `O`, `Esc`; `v` / `V` visual |
| Motions | `h j k l` (arrows too), `0 ^ $` (`Home`/`End`), `w b e W B E`, `gg G`, `{ }`, `H M L`, `f t F T ; ,`, `%`, `PgUp`/`PgDn` |
| Counts | `3j`, `2dd`, `4x`, … |
| Edit | `x X r s S C D dd dw d$ d0 dG dj dk`, `cc cw`, `J`, `~`, `>>` `<<`, `p P u Ctrl+r .` |
| Line numbers | `:{n}` |
| Search | `/pattern`, `?pattern`, `n`, `N`, `*`, `#` |
| Command line | `:w`, `:w <path>`, `:q`, `:q!`, `:wq`, `:e <path>`, `:e!` |
| Registers | `"a` … `"z`, `"+` / `"*` (OSC 52 clipboard on yank) |

Text is highlighted with the host theme through tree-sitter; unknown file types
stay plain.

### Requires

- OpenCode v2 (built and tested against 2.4.x).
- A PDF rasterizer for `/preview *.pdf`: `pdftoppm` (poppler-utils), `mutool`
  (mupdf-tools) or `gs` (ghostscript), in that order of preference. Without one
  the viewer explains what to install.
- A graphics-capable terminal for pixel images. `kitty`, `ghostty`, `wezterm`,
  `foot` and similar use the kitty protocol; `xterm`/`mlterm` use sixel. Other
  terminals fall back to colored blocks.

## Limitations

- Text editing is intentionally a small vim subset: no macros (`q`), no
  `:s` substitutions, no folds, no search highlighting, no multi-line insert
  repeat beyond `.`, non-incremental tree-sitter re-parsing (debounced).
- PDF page count uses `pdfinfo` when available; otherwise the last page is
  discovered by trying the next one.
- Binary files are shown as a hex dump and never written back.

## Development

```sh
npm install
npm run typecheck     # tsc
npm test              # bun test (engine, util, and a real-renderer integration test)
npm run test:unit     # node test runner for the pure modules
```

The vim engine (`vim/engine.ts`) is renderer-free and unit-tested against an
in-memory buffer; `vim/buffer.ts` adapts an OpenTUI `EditBuffer`.

## License

GPL-3.0-only. Not affiliated with the OpenCode team.
