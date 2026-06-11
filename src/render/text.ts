/**
 * renderText(WidgetData) → plain text.
 *
 * For terminals + text-only models. Default implementation strips Markdown
 * down to plain text; specific widgets can override for cleaner output.
 */

import type { WidgetData } from "../widgets.js";
import { renderMarkdown, type RenderOpts } from "./markdown.js";

export function renderText(w: WidgetData, opts?: RenderOpts): string {
  // Reuse the Markdown renderer and strip Markdown syntax.
  return renderMarkdown(w, opts)
    .replace(/^#+\s*/gm, "")        // headings
    .replace(/\*\*(.*?)\*\*/g, "$1") // bold
    .replace(/_(.*?)_/g, "$1")       // italic
    .replace(/`([^`]+)`/g, "$1")     // inline code
    .replace(/^\|[^\n]*\|$/gm, l =>  // table rows: simple pipe-strip
      l.replace(/^\|/, "").replace(/\|$/, "").trim().replace(/\s*\|\s*/g, "  "))
    .replace(/^[-]+\s*/gm, "  ")     // list bullets to indent
    .trim();
}
