/**
 * Size-aware renderMarkdown — the six-tier density contract.
 *
 * icon = identity only, row = one line, small…xlarge = budgeted full
 * renders, no opts = legacy full render (unchanged output).
 */

import { test, expect, describe } from "bun:test";
import { renderMarkdown } from "./markdown.js";
import { renderText } from "./text.js";
import type { WidgetData, ListWidget, TableWidget, PlanWidget } from "../widgets.js";

const list = (n: number): ListWidget => ({
  type: "list",
  title: "Inbox",
  items: Array.from({ length: n }, (_, i) => ({
    title: `Mail ${i + 1}`,
    subtitle: `sender${i + 1}@example.com`,
  })),
});

const table = (n: number): TableWidget => ({
  type: "table",
  title: "Orders",
  columns: ["id", "amount"],
  rows: Array.from({ length: n }, (_, i) => ({ id: `o${i + 1}`, amount: i * 10 })),
});

const plan: PlanWidget = {
  type: "plan",
  title: "Deploy",
  steps: [
    { label: "build", status: "completed" },
    { label: "test", status: "in_progress" },
    { label: "ship", status: "pending" },
  ],
};

describe("legacy (no opts) is unchanged", () => {
  test("list caps at 30 with more-footer", () => {
    const md = renderMarkdown(list(40));
    expect(md).toContain("**Mail 30**");
    expect(md).not.toContain("**Mail 31**");
    expect(md).toContain("_… 10 more_");
  });

  test("document truncates at 600 chars", () => {
    const md = renderMarkdown({ type: "document", title: "Doc", body: "x".repeat(700) });
    expect(md).toContain("x".repeat(600) + "…");
  });
});

describe("icon: identity only", () => {
  test("list → title + count, no items", () => {
    const md = renderMarkdown(list(12), { size: "icon" });
    expect(md).toBe("**Inbox** · 12 items");
  });

  test("plan → progress", () => {
    expect(renderMarkdown(plan, { size: "icon" })).toBe("**Deploy** · 1/3 done");
  });

  test("status → state + message", () => {
    const md = renderMarkdown({ type: "status", state: "ok", message: "live" }, { size: "icon" });
    expect(md).toBe("✓ **live**");
  });
});

describe("row: one line", () => {
  test("list → count + first titles, single line", () => {
    const md = renderMarkdown(list(12), { size: "row" });
    expect(md).toContain("12 items");
    expect(md).toContain("Mail 1");
    expect(md).not.toContain("\n");
    expect(md.length).toBeLessThanOrEqual(161); // 160 + ellipsis
  });

  test("table → dimensions, no rows", () => {
    const md = renderMarkdown(table(45), { size: "row" });
    expect(md).toBe("**Orders** · 45 rows × 2 cols");
  });

  test("plan → progress + current step", () => {
    const md = renderMarkdown(plan, { size: "row" });
    expect(md).toBe("**Deploy** · 1/3 done — current: test");
  });

  test("calendar → next event", () => {
    const md = renderMarkdown({
      type: "calendar", title: "Week",
      events: [{ title: "Standup", startsAt: "2026-06-12T09:00:00Z" }],
    }, { size: "row" });
    expect(md).toContain("next:");
    expect(md).toContain("Standup");
  });
});

describe("small…xlarge budgets", () => {
  test("small list shows 4", () => {
    const md = renderMarkdown(list(12), { size: "small" });
    expect(md).toContain("**Mail 4**");
    expect(md).not.toContain("**Mail 5**");
    expect(md).toContain("_… 8 more_");
  });

  test("medium table shows 6 rows", () => {
    const md = renderMarkdown(table(20), { size: "medium" });
    expect(md).toContain("| o6 |");
    expect(md).not.toContain("| o7 |");
    expect(md).toContain("_… 14 more rows_");
  });

  test("xlarge list shows 30", () => {
    const md = renderMarkdown(list(40), { size: "xlarge" });
    expect(md).toContain("**Mail 30**");
    expect(md).toContain("_… 10 more_");
  });

  test("totalItems drives the footer when items are pre-sliced", () => {
    const w = { ...list(8), totalItems: 100 };
    const md = renderMarkdown(w, { size: "medium" });
    expect(md).toContain("_… 92 more_");
  });

  test("stack threads budget to children", () => {
    const w: WidgetData = { type: "stack", header: { title: "Wrap" }, body: [list(12)] };
    const md = renderMarkdown(w, { size: "small" });
    expect(md).toContain("**Mail 4**");
    expect(md).not.toContain("**Mail 5**");
  });
});

describe("renderText passes size through", () => {
  test("row stays one line, markdown stripped", () => {
    const txt = renderText(list(12), { size: "row" });
    expect(txt).not.toContain("**");
    expect(txt).toContain("12 items");
  });
});

describe("every type renders at every size without throwing", () => {
  const samples: WidgetData[] = [
    { type: "icon", glyph: "<svg/>", color: "blue", label: "App", badge: 3 },
    { type: "stack", header: { title: "S" }, body: [list(2)] },
    list(3),
    table(3),
    { type: "metric", label: "MRR", value: 100, unit: "€", trend: "up", trendValue: "+5%" },
    { type: "metric_grid", metrics: [{ type: "metric", label: "A", value: 1 }, { type: "metric", label: "B", value: 2 }] },
    { type: "key_value", title: "KV", pairs: [{ key: "k", value: "v" }] },
    { type: "status", state: "warn", message: "degraded", details: [{ key: "region", value: "eu" }] },
    { type: "document", title: "D", body: "hello\nworld" },
    { type: "calendar", title: "C", events: [{ title: "E", startsAt: "2026-06-12T09:00:00Z" }] },
    plan,
    { type: "empty", message: "nothing here" },
    { type: "model_3d", uri: "https://x/m.glb", format: "glb", name: "Part" },
  ];
  const sizes = ["icon", "row", "small", "medium", "large", "xlarge", undefined] as const;

  for (const w of samples) {
    for (const size of sizes) {
      test(`${w.type} @ ${size ?? "legacy"}`, () => {
        const md = renderMarkdown(w, size ? { size } : undefined);
        expect(typeof md).toBe("string");
        expect(md.length).toBeGreaterThan(0);
        if (size === "row") expect(md).not.toContain("\n");
      });
    }
  }
});
