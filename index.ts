// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

/**
 * opencode-preview — server part.
 *
 * The viewer is entirely a TUI plugin (./tui). This part exists because the
 * TUI only loads the `tui` entrypoint of plugins the server activated: a
 * package with no server entrypoint is never `active` and its TUI part is
 * skipped. It registers nothing.
 */

import type { Plugin as NS } from "@opencode/plugin"

export default {
  id: "preview",
  setup() {},
} satisfies NS.Plugin
