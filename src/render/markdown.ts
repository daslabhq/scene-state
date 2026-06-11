/**
 * renderMarkdown(WidgetData, opts?) → Markdown string.
 *
 * Token-efficient summaries for LLM context. Same source-of-truth JSON as
 * the HTML renderer, just a different output target.
 *
 * Size-aware: pass `{ size }` to render at a semantic density matching the
 * visual grid tier — the same WidgetData a user sees as a 4×1 row tile
 * renders as a one-line summary; a 4×4 large tile renders in full.
 *
 *   icon    identity only — name/label, no data
 *   row     one line — identity + compact state summary
 *   small   a few items / 512 chars
 *   medium  ~8 items / 2k chars
 *   large   ~15 items / 8k chars
 *   xlarge  ~30 items / 32k chars
 *
 * Omitting `size` keeps the legacy full render (caps lists/tables at 30,
 * documents at 600 chars) — byte-stable for existing callers.
 */

import type {
  WidgetData, IconWidget, StackWidget, ListWidget, TableWidget,
  MetricWidget, MetricGridWidget, KeyValueWidget, StatusWidget,
  DocumentWidget, CalendarWidget, PlanWidget, EmptyWidget,
  Model3DWidget,
} from "../widgets.js";
import type { ViewSize } from "../view.js";
import { truncate } from "../view.js";

export interface RenderOpts {
  /** Semantic density — same six-tier ladder as the visual grid. Omitted → legacy full render. */
  size?: ViewSize;
}

export function renderMarkdown(w: WidgetData, opts?: RenderOpts): string {
  const size = opts?.size;
  if (size === "icon") return renderIdentity(w);
  if (size === "row") return renderRowLine(w);
  return renderFull(w, size ? BUDGETS[size] : LEGACY_BUDGET);
}

// ── Budgets (the density contract) ──────────────────────────────────

/** Visible-item caps per tier — mirrors what each visual renderer shows
 *  on screen at that size, so agent and user see the same slice. */
interface Budget {
  listItems: number;
  tableRows: number;
  events:    number;
  docChars:  number;
  pairs:     number;
  steps:     number;
  metrics:   number;
}

const BUDGETS: Record<Exclude<ViewSize, "icon" | "row">, Budget> = {
  small:  { listItems: 4,  tableRows: 3,  events: 3,  docChars: 512,   pairs: 4,  steps: 4,  metrics: 4 },
  medium: { listItems: 8,  tableRows: 6,  events: 8,  docChars: 2048,  pairs: 8,  steps: 8,  metrics: 8 },
  large:  { listItems: 15, tableRows: 12, events: 15, docChars: 8192,  pairs: 15, steps: 15, metrics: 15 },
  xlarge: { listItems: 30, tableRows: 25, events: 30, docChars: 32768, pairs: 30, steps: 30, metrics: 30 },
};

/** No-size callers keep the historical output exactly. */
const LEGACY_BUDGET: Budget = {
  listItems: 30, tableRows: 30, events: 20, docChars: 600,
  pairs: Infinity, steps: Infinity, metrics: Infinity,
};

// ── icon: identity only ─────────────────────────────────────────────

function renderIdentity(w: WidgetData): string {
  switch (w.type) {
    case "icon":        return renderIcon(w);
    case "stack":       return w.header ? `**${w.header.title}**` : renderIdentity(w.body[0] ?? { type: "empty" });
    case "list":        return `**${w.title ?? "List"}** · ${w.totalItems ?? w.items.length} items`;
    case "table":       return `**${w.title ?? "Table"}** · ${w.totalRows ?? w.rows.length} rows`;
    case "metric":      return `**${w.label}**`;
    case "metric_grid": return `${w.metrics.length} metrics`;
    case "key_value":   return `**${w.title ?? "Details"}** · ${w.pairs.length} fields`;
    case "status":      return `${statusIcon(w.state)} **${w.message}**`;
    case "document":    return `**${w.title ?? "Document"}**`;
    case "calendar":    return `**${w.title ?? "Calendar"}** · ${w.events.length} events`;
    case "plan":        return `**${w.title}** · ${planProgress(w)}`;
    case "empty":       return w.message ?? "(empty)";
    case "model_3d":    return `🧊 **${w.name ?? "3D model"}**`;
  }
}

// ── row: one line — identity + compact state ────────────────────────

const ROW_MAX_CHARS = 160;

function renderRowLine(w: WidgetData): string {
  return truncate(rowLine(w).replace(/\n+/g, " · "), ROW_MAX_CHARS);
}

function rowLine(w: WidgetData): string {
  switch (w.type) {
    case "icon":        return renderIcon(w);
    case "stack":       return w.header
      ? `**${w.header.title}**${w.header.meta ? ` · ${w.header.meta}` : ""}`
      : rowLine(w.body[0] ?? { type: "empty" });
    case "list": {
      const head = `**${w.title ?? "List"}** · ${w.totalItems ?? w.items.length} items`;
      const peek = w.items.slice(0, 3).map(i => i.title).join("; ");
      return peek ? `${head} — ${peek}` : head;
    }
    case "table":       return `**${w.title ?? "Table"}** · ${w.totalRows ?? w.rows.length} rows × ${w.columns.length} cols`;
    case "metric":      return renderMetric(w);
    case "metric_grid": return w.metrics.slice(0, 4).map(renderMetric).join(" · ");
    case "key_value":   return `**${w.title ?? "Details"}** — ${w.pairs.slice(0, 4).map(p => `${p.key}: ${p.value}`).join(" · ")}`;
    case "status": {
      const first = w.details?.[0];
      return `${statusIcon(w.state)} **${w.message}**${first ? ` — ${first.key}: ${first.value}` : ""}`;
    }
    case "document":    return `**${w.title ?? "Document"}**${w.body ? ` — ${firstLine(w.body)}` : ""}`;
    case "calendar": {
      const next = w.events[0];
      const head = `**${w.title ?? "Calendar"}** · ${w.events.length} events`;
      return next ? `${head} — next: ${formatDateTime(next.startsAt)} ${next.title}` : head;
    }
    case "plan": {
      const current = w.steps.find(s => s.status === "in_progress") ?? w.steps.find(s => s.status === "pending");
      return `**${w.title}** · ${planProgress(w)}${current ? ` — current: ${current.label}` : ""}`;
    }
    case "empty":       return w.message ?? "(empty)";
    case "model_3d":    return renderModel3D(w);
  }
}

// ── small…xlarge + legacy: full render under a budget ───────────────

function renderFull(w: WidgetData, b: Budget): string {
  switch (w.type) {
    case "icon":        return renderIcon(w);
    case "stack":       return renderStack(w, b);
    case "list":        return renderList(w, b);
    case "table":       return renderTable(w, b);
    case "metric":      return renderMetric(w);
    case "metric_grid": return renderMetricGrid(w, b);
    case "key_value":   return renderKeyValue(w, b);
    case "status":      return renderStatus(w);
    case "document":    return renderDocument(w, b);
    case "calendar":    return renderCalendar(w, b);
    case "plan":        return renderPlan(w, b);
    case "empty":       return renderEmpty(w);
    case "model_3d":    return renderModel3D(w);
  }
}

const COLOR_EMOJI: Record<string, string> = {
  blue: "🔵", green: "🟢", purple: "🟣", red: "🔴",
  orange: "🟠", yellow: "🟡", indigo: "🟣", pink: "🩷",
  teal: "🔷", gray: "⚪️",
};

function renderIcon(w: IconWidget): string {
  const dot = COLOR_EMOJI[w.color] ?? "";
  return `${dot} **${w.label}**${w.badge ? ` · ${w.badge}` : ""}`;
}

function renderStack(w: StackWidget, b: Budget): string {
  const head = w.header
    ? `**${w.header.title}**${w.header.meta ? ` · ${w.header.meta}` : ""}\n\n`
    : "";
  const body = w.body.map(x => renderFull(x, b)).join("\n\n");
  return head + body;
}

function renderList(w: ListWidget, b: Budget): string {
  if (w.items.length === 0) {
    return w.title ? `**${w.title}**: ${w.empty ?? "(empty)"}` : (w.empty ?? "(empty)");
  }
  const lines = w.items.slice(0, b.listItems).map(i => {
    const badge = i.badge ? ` \`${i.badge}\`` : "";
    const sub = i.subtitle ? ` — ${i.subtitle}` : "";
    const det = i.detail ? `\n  > ${truncate(i.detail, 140)}` : "";
    return `- **${i.title}**${badge}${sub}${det}`;
  }).join("\n");
  const total = w.totalItems ?? w.items.length;
  const more = total > b.listItems ? `\n_… ${total - b.listItems} more_` : "";
  return `${w.title ? `**${w.title}**\n\n` : ""}${lines}${more}`;
}

function renderTable(w: TableWidget, b: Budget): string {
  if (w.rows.length === 0) return w.title ? `**${w.title}**: (empty)` : "(empty)";
  const head = `| ${w.columns.join(" | ")} |\n| ${w.columns.map(() => "---").join(" | ")} |`;
  const body = w.rows.slice(0, b.tableRows).map(r =>
    `| ${w.columns.map(c => formatCell(r[c]).replace(/\|/g, "\\|")).join(" | ")} |`
  ).join("\n");
  const total = w.totalRows ?? w.rows.length;
  const more = total > b.tableRows ? `\n_… ${total - b.tableRows} more rows_` : "";
  return `${w.title ? `**${w.title}**\n\n` : ""}${head}\n${body}${more}`;
}

function renderMetric(w: MetricWidget): string {
  const arrow = w.trend === "up" ? "↑" : w.trend === "down" ? "↓" : "";
  return `**${w.label}**: ${w.value}${w.unit ? ` ${w.unit}` : ""}${w.trendValue ? ` (${arrow} ${w.trendValue})` : ""}`;
}

function renderMetricGrid(w: MetricGridWidget, b: Budget): string {
  const shown = w.metrics.slice(0, b.metrics).map(renderMetric).join(" · ");
  const more = w.metrics.length > b.metrics ? ` _… ${w.metrics.length - b.metrics} more_` : "";
  return shown + more;
}

function renderKeyValue(w: KeyValueWidget, b: Budget): string {
  const lines = w.pairs.slice(0, b.pairs).map(({ key, value }) => `- **${key}**: ${value}`).join("\n");
  const more = w.pairs.length > b.pairs ? `\n_… ${w.pairs.length - b.pairs} more_` : "";
  return `${w.title ? `**${w.title}**\n\n` : ""}${lines}${more}`;
}

function renderStatus(w: StatusWidget): string {
  const det  = w.details?.length ? "\n" + w.details.map(d => `- **${d.key}**: ${d.value}`).join("\n") : "";
  return `${statusIcon(w.state)} **${w.message}**${det}`;
}

function renderDocument(w: DocumentWidget, b: Budget): string {
  return `${w.title ? `### ${w.title}\n\n` : ""}${w.byline ? `_${w.byline}_\n\n` : ""}${truncate(w.body, b.docChars)}`;
}

function renderCalendar(w: CalendarWidget, b: Budget): string {
  if (w.events.length === 0) return w.title ? `**${w.title}**: no events` : "no events";
  const lines = w.events.slice(0, b.events).map(e => {
    const time = e.allDay ? formatDate(e.startsAt) : formatDateTime(e.startsAt);
    const loc  = e.location ? ` · ${e.location}` : "";
    return `- **${time}** — ${e.title}${loc}`;
  }).join("\n");
  const more = w.events.length > b.events ? `\n_… ${w.events.length - b.events} more_` : "";
  return `${w.title ? `**${w.title}**\n\n` : ""}${lines}${more}`;
}

function renderPlan(w: PlanWidget, b: Budget): string {
  const mark = (s: PlanStep["status"]) => ({
    pending: "[ ]", in_progress: "[~]", completed: "[x]", failed: "[!]", skipped: "[-]",
  })[s];
  const lines = w.steps.slice(0, b.steps).map(s => `- ${mark(s.status)} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`).join("\n");
  const more = w.steps.length > b.steps ? `\n_… ${w.steps.length - b.steps} more_` : "";
  return `**${w.title}**\n\n` + lines + more;
}

function renderEmpty(w: EmptyWidget): string {
  return w.message ?? "(empty)";
}

function renderModel3D(w: Model3DWidget): string {
  const name = w.name ?? "3D model";
  const parts: string[] = [w.format.toUpperCase()];
  if (w.vertexCount != null) {
    const noun = (w.format === "pdb" || w.format === "mmcif") ? "atoms" : "verts";
    parts.push(`${w.vertexCount.toLocaleString()} ${noun}`);
  }
  if (w.bounds) {
    const u = w.bounds.unit ?? "";
    const fmt = (n: number) => {
      const s = n.toFixed(n < 10 ? 2 : 1);
      return u ? `${s}${u}` : s;
    };
    parts.push(`${fmt(w.bounds.width)} × ${fmt(w.bounds.height)} × ${fmt(w.bounds.depth)}`);
  }
  return `🧊 **${name}** — ${parts.join(" · ")}`;
}

// helpers
type PlanStep = PlanWidget["steps"][number];

function statusIcon(state: StatusWidget["state"]): string {
  return state === "ok" ? "✓" : state === "warn" ? "⚠️" : "✗";
}

function planProgress(w: PlanWidget): string {
  return `${w.steps.filter(s => s.status === "completed").length}/${w.steps.length} done`;
}

function firstLine(s: string): string {
  return truncate(s.split("\n").find(l => l.trim().length > 0) ?? "", 100);
}

function formatCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return truncate(v, 80);
  if (typeof v === "object") return truncate(JSON.stringify(v), 80);
  return String(v);
}
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
