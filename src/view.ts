/**
 * View — render asset state in multiple media (HTML / Markdown / Text)
 * at multiple sizes (icon / small / medium / large / xlarge).
 *
 * Same definition produces:
 *   - HTML        for human-visual rendering (dashboards, scrubbers, iOS)
 *   - Markdown    for LLM-context injection (token-efficient summaries)
 *   - Text        for terminal output and text-only models
 *
 * Sizes match Apple WidgetKit and Daslab's `WidgetSize` enum:
 *   icon:   1×1   identity only (name + icon, no fetched data)
 *   small:  2×2   one headline metric / 2-line summary
 *   medium: 4×2   short table or 2-3 metric grid
 *   large:  4×4   full glanceable summary
 *   xlarge: 8×4   multi-section, wide tables (iPad / desktop)
 *
 * Token-budget guidance (Markdown render):
 *   icon:   ~5 tokens     small: ~30      medium: ~80
 *   large: ~250          xlarge: ~800+
 *
 * Authors implement what they want. Sizes not implemented fall back through
 * the ladder: icon→small→medium, large→medium, xlarge→large→medium.
 */

import { renderHTML }     from "./render/html.js";
import { renderMarkdown } from "./render/markdown.js";
import { renderText }     from "./render/text.js";

export type JSONSchema = Record<string, unknown>;

/** Six-tier size system — matches Apple WidgetKit + Daslab WidgetSize.
 *  `row` is the Apple-Notes-style full-width thin row (4×1). */
export type ViewSize = "icon" | "row" | "small" | "medium" | "large" | "xlarge";

/** Alias for Daslab's existing vocabulary — same values. */
export type WidgetSize = ViewSize;

export interface ViewOpts {
  /** Render at this size; default "medium". */
  size?: ViewSize;
}

export interface ViewDef<TState = unknown> {
  /** Stable view name, e.g. "GmailInbox". */
  name: string;
  /** Optional human-readable description (helps LLM tool specs / UIs). */
  description?: string;
  /** Optional JSON Schema for the input state. */
  schema?: JSONSchema;
  /**
   * Return the canonical WidgetData JSON for the requested size, or null if
   * this view uses the legacy escape-hatch (toHTML/toMarkdown only). Useful
   * for previewing the JSON in galleries / docs / tooling.
   */
  toJSON?(state: TState, opts?: ViewOpts): import("./widgets.js").WidgetData | null;
  /** Render to HTML at the requested size (default "medium"). */
  toHTML(state: TState, opts?: ViewOpts): string;
  /** Render to Markdown at the requested size (default "medium"). */
  toMarkdown(state: TState, opts?: ViewOpts): string;
  /** Render to plain text — for terminals + text-only models. */
  toText?(state: TState, opts?: ViewOpts): string;
}

// ---------------------------------------------------------------------------
// Sized builder — declarative authoring with auto-fallback
// ---------------------------------------------------------------------------

/**
 * A renderer at a single size — preferred form. Returns WidgetData JSON;
 * the framework converts to HTML / Markdown / Text via the renderers in
 * `src/render/`. View authors don't write parallel HTML and Markdown.
 */
export type WidgetSizedRenderer<TState> = (state: TState) => import("./widgets.js").WidgetData;

/**
 * Legacy form — author returns HTML + Markdown strings directly. Kept as
 * an escape hatch for views the WidgetData union can't express. Prefer
 * the WidgetData form unless you have a specific reason.
 */
export interface SizedRender {
  html:     string;
  markdown: string;
  text?:    string;
}

export type SizedRenderer<TState> = (state: TState) => SizedRender;

/** Per-size map — values can be WidgetData renderers OR legacy {html,markdown} renderers. */
export type SizedMap<TState> = Partial<Record<ViewSize, WidgetSizedRenderer<TState> | SizedRenderer<TState>>>;

export interface ViewDefConfig<TState> {
  name: string;
  description?: string;
  schema?: JSONSchema;
  /** Per-size renderers — preferred form. Values return WidgetData; framework renders. */
  sizes?: SizedMap<TState>;
  /** Single-size renderer (full custom escape hatch). */
  toHTML?: (state: TState, opts?: ViewOpts) => string;
  toMarkdown?: (state: TState, opts?: ViewOpts) => string;
  toText?: (state: TState, opts?: ViewOpts) => string;
}

/**
 * Build a view. Two patterns are supported:
 *
 *   // 1. Sized builder — preferred for assets that vary across sizes
 *   defineView({
 *     name: "Inbox",
 *     sizes: {
 *       icon:   (s) => ({ html: "📧 5", markdown: "📧 5" }),
 *       small:  (s) => ({ html: "...",  markdown: "..." }),
 *       medium: (s) => ({ html: "...",  markdown: "..." }),
 *     },
 *   });
 *
 *   // 2. Explicit functions — full control, ignore sizes
 *   defineView({
 *     name: "Static",
 *     toHTML(s, opts) { ... },
 *     toMarkdown(s, opts) { ... },
 *   });
 *
 * Sizes not implemented fall back through the ladder.
 */
export function defineView<TState = unknown>(config: ViewDefConfig<TState>): ViewDef<TState> {
  const { sizes } = config;

  if (sizes) {
    const resolveSize = (size: ViewSize): WidgetSizedRenderer<TState> | SizedRenderer<TState> | undefined => {
      const ladder: ViewSize[] = (() => {
        switch (size) {
          case "icon":   return ["icon", "small", "medium"];
          case "row":    return ["row", "small", "medium"];
          case "small":  return ["small", "medium"];
          case "medium": return ["medium"];
          case "large":  return ["large", "medium"];
          case "xlarge": return ["xlarge", "large", "medium"];
        }
      })();
      for (const s of ladder) {
        if (sizes[s]) return sizes[s];
      }
      return Object.values(sizes).find(Boolean);
    };

    const callSized = (state: TState, opts: ViewOpts | undefined): { kind: "widget"; data: any } | { kind: "legacy"; out: SizedRender } | null => {
      const fn = resolveSize(opts?.size ?? "medium");
      if (!fn) return null;
      const out = fn(state) as any;
      // WidgetData has a `type` discriminator that's a known string; SizedRender
      // has html + markdown fields. Distinguish.
      if (out && typeof out === "object" && typeof out.type === "string" && !("html" in out)) {
        return { kind: "widget", data: out };
      }
      return { kind: "legacy", out: out as SizedRender };
    };

    const toHTML = (state: TState, opts?: ViewOpts) => {
      const c = callSized(state, opts);
      if (!c) return "";
      return c.kind === "widget" ? renderHTML(c.data) : c.out.html;
    };
    const toMarkdown = (state: TState, opts?: ViewOpts) => {
      const c = callSized(state, opts);
      if (!c) return "";
      return c.kind === "widget" ? renderMarkdown(c.data) : c.out.markdown;
    };
    const toText = (state: TState, opts?: ViewOpts) => {
      const c = callSized(state, opts);
      if (!c) return "";
      if (c.kind === "widget") return renderText(c.data);
      return c.out.text ?? stripTags(c.out.html);
    };
    const toJSON = (state: TState, opts?: ViewOpts) => {
      const c = callSized(state, opts);
      if (!c) return null;
      return c.kind === "widget" ? c.data : null;
    };

    return {
      name:       config.name,
      description: config.description,
      schema:     config.schema,
      toHTML:     config.toHTML     ?? toHTML,
      toMarkdown: config.toMarkdown ?? toMarkdown,
      toText:     config.toText     ?? toText,
      toJSON,
    };
  }

  if (!config.toHTML || !config.toMarkdown) {
    throw new Error(`defineView(${config.name}): provide either \`sizes\` or both \`toHTML\` and \`toMarkdown\``);
  }
  return {
    name:       config.name,
    description: config.description,
    schema:     config.schema,
    toHTML:     config.toHTML,
    toMarkdown: config.toMarkdown,
    toText:     config.toText ?? ((state, opts) => stripTags(config.toHTML!(state, opts))),
  };
}

// ---------------------------------------------------------------------------
// Helpers reused by built-in views
// ---------------------------------------------------------------------------

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c] as string);
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Pixel dimensions per size (matches Daslab's widgetSizeCols / widgetSizeRows). */
export function viewSizeGrid(size: ViewSize): { cols: number; rows: number } {
  switch (size) {
    case "icon":   return { cols: 1, rows: 1 };
    case "row":    return { cols: 4, rows: 1 };
    case "small":  return { cols: 2, rows: 2 };
    case "medium": return { cols: 4, rows: 2 };
    case "large":  return { cols: 4, rows: 4 };
    case "xlarge": return { cols: 8, rows: 4 };
  }
}
