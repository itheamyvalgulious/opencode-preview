// SPDX-FileCopyrightText: 2026 ItheaValgulious
// SPDX-License-Identifier: GPL-3.0-only

import { SyntaxStyle, type NativeResourceOwner, type RGBA, type ThemeTokenStyle } from "@opentui/core"

/**
 * Builds a `SyntaxStyle` from the host theme's syntax tokens.
 *
 * Kept local (instead of importing `@opencode/theme`) so the plugin holds a
 * single copy of `@opentui/core` at the type level and does not break when the
 * host's theme package is resolved separately.
 */

type Color = RGBA

type ThemeTokens = {
  text: {
    base: Color
    muted: Color
    feedback: { error: { base: Color }; warning: { base: Color }; info: { base: Color }; success: { base: Color } }
  }
  background: { base: Color; raised: { base: Color } }
  syntax: {
    comment: Color
    string: Color
    number: Color
    keyword: Color
    type: Color
    function: Color
    operator: Color
    punctuation: Color
    variable: Color
  }
  markdown: {
    heading: Color
    strong: Color
    emphasis: Color
    listItem: Color
    blockQuote: Color
    code: Color
    link: Color
    linkText: Color
  }
}

const rule = (
  scope: string[],
  foreground: Color,
  style: Omit<ThemeTokenStyle["style"], "foreground"> = {},
): ThemeTokenStyle => ({ scope, style: { foreground, ...style } })

export function createSyntax(theme: unknown, owner: NativeResourceOwner): SyntaxStyle {
  const tokens = theme as ThemeTokens
  const rules: ThemeTokenStyle[] = [
    rule(["default"], tokens.text.base),
    rule(["comment", "comment.documentation"], tokens.syntax.comment, { italic: true }),
    rule(["comment.error"], tokens.text.feedback.error.base, { italic: true, bold: true }),
    rule(["comment.warning"], tokens.text.feedback.warning.base, { italic: true, bold: true }),
    rule(["comment.todo", "comment.note"], tokens.text.feedback.info.base, { italic: true, bold: true }),
    rule(["string", "symbol", "character", "character.special"], tokens.syntax.string),
    rule(["number", "boolean", "constant", "float"], tokens.syntax.number),
    rule(["keyword", "keyword.import", "keyword.return", "keyword.conditional", "keyword.repeat"], tokens.syntax.keyword, {
      italic: true,
    }),
    rule(["keyword.type", "type", "type.builtin", "module", "class", "namespace"], tokens.syntax.type, { bold: true }),
    rule(["function", "function.call", "function.method", "function.method.call", "constructor"], tokens.syntax.function),
    rule(["variable", "variable.parameter", "variable.member", "property", "field", "parameter"], tokens.syntax.variable),
    rule(["operator", "keyword.operator", "punctuation.special"], tokens.syntax.operator),
    rule(["punctuation", "punctuation.bracket", "punctuation.delimiter"], tokens.syntax.punctuation),
    rule(["markup.heading", "markup.heading.1", "markup.heading.2", "markup.heading.3"], tokens.markdown.heading, {
      bold: true,
    }),
    rule(["markup.bold", "markup.strong"], tokens.markdown.strong, { bold: true }),
    rule(["markup.italic"], tokens.markdown.emphasis, { italic: true }),
    rule(["markup.list"], tokens.markdown.listItem),
    rule(["markup.quote"], tokens.markdown.blockQuote, { italic: true }),
    rule(["markup.raw", "markup.raw.block", "markup.raw.inline"], tokens.markdown.code),
    rule(["markup.link", "markup.link.url", "string.special.url"], tokens.markdown.link, { underline: true }),
    rule(["markup.link.label", "label"], tokens.markdown.linkText, { underline: true }),
    rule(["attribute", "annotation", "tag"], tokens.text.feedback.warning.base),
    rule(["error"], tokens.text.feedback.error.base, { bold: true }),
    rule(["warning"], tokens.text.feedback.warning.base, { bold: true }),
    rule(["info"], tokens.text.feedback.info.base),
    rule(["markup.strikethrough", "debug"], tokens.text.muted),
  ]
  return SyntaxStyle.fromTheme(rules, owner)
}
