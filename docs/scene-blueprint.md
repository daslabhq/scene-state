# scene-blueprint v1

> Declarative JSON for scenes. Apply, export, fork, merge — git-shaped semantics.

`scene-blueprint` is the wire format for an entire scene tree: identity, assets, recurring agent tasks, evaluable scenarios, access grants. It compiles a scene into a single file (or a directory with sidecar HTML/markdown), produced by `export`, consumed by `apply`. Round-tripping is byte-stable for everything the format captures; per-asset three-way merge against the scene's commit history catches conflicts before any DB write.

It sits below [`scenecast`](../README.md) (asset shapes, views, rendering) and above [`scene-otel`](https://github.com/daslabhq/scene-otel) (the runtime snapshot wire format). A blueprint *declares* a scene; scene-otel events *describe* its runtime mutations; [`autocheck`](https://github.com/daslabhq/autocheck) *grades* what the agent did inside it.

| | |
|---|---|
| **Schema** | [`schemas/scene-blueprint-v1.json`](../schemas/scene-blueprint-v1.json) (JSON Schema draft 2020-12) |
| **Status** | v1 — stable. Reserved fields documented below. Additive v1.x changes only. |
| **Reference impl** | [`daslab/server/src/lib/scene-blueprint/`](https://github.com/daslabhq/daslab/tree/main/server/src/lib/scene-blueprint) |

---

## 30-second example

```jsonc
{
  "$schema": "https://daslab.dev/schemas/scene-blueprint-v1.json",
  "version": 1,

  "id":   "scn_my_world",
  "slug": "my-world",
  "name": "My World",
  "icon": "globe",
  "tint": "#4C8BF5",

  "settings": {
    "description": "First scene built from a blueprint."
  },

  "assets": [
    {
      "id":   "intro",
      "type": "daslab/note",
      "name": "About",
      "fields": { "content": "# Hello\n\nThis scene was authored as a blueprint." },
      "layout": { "sortOrder": 0, "size": "large" }
    }
  ],

  "members": [
    { "principal": "github:octocat", "role": "owner" }
  ]
}
```

Apply it:

```bash
bun run scripts/apply-blueprint.ts ./my-world.blueprint.json
# ✓ scenes upserted (1):  · scn_my_world
# 1 asset(s):    + intro     → ast_...   [scn_my_world]
# 1 member(s):   ✓ github:octocat → usr_...   [scn_my_world]
```

That's the entire surface, end-to-end. Everything else in this document refines it.

---

## Concepts

### The scene block is recursive

A blueprint *is* a scene block. A scene block describes:

- Its **identity** at the top (id, parentId, slug, name, icon, tint)
- Its **settings** in `settings` (the iOS settings sheet)
- Its **content** in `assets[]`, `linkedAssets[]`, `schedules[]`, `tasks[]`, `members[]`
- Its **children** in `scenes[]` — each child is a scene block too

A single file holds a tree of arbitrary depth. Children inherit `parentId` from enclosing context; members inherit owner attribution downward so sub-scenes can have schedules without re-declaring members at every level.

```jsonc
{
  "id": "scn_root", "name": "Root",
  "members": [{ "principal": "github:octocat", "role": "owner" }],
  "scenes": [
    {
      "id": "scn_child", "name": "Child",
      "schedules": [{ "id": "...", "cron": "0 6 * * *", "prompt": "..." }]
      //  schedule runs as the inherited owner
    }
  ]
}
```

### `assets[]` vs `linkedAssets[]`

This is the load-bearing split. Get it right and round-tripping works; get it wrong and you fork DB rows.

| | `assets[]` | `linkedAssets[]` |
|---|---|---|
| What | Scene-owned. Created by the blueprint. | Foreign rows. Already exist. Pinned to the scene. |
| DB id | Derived: `assetId(sceneId, type, externalId)` | Stable: kept as-is across applies |
| Fields | Authored in the blueprint, written to the row | Optional — when present, **edit-in-place** (same row id, content updated) |
| Apply behavior | `INSERT … ON CONFLICT UPDATE` the row | `UPDATE` row fields (if blueprint declares them) + link via `scene_assets` |
| Use for | Notes, webviews, queries, anything the blueprint produces | Account chips, accounts, github repos, slack channels, SAP/SF entities — rows whose identity lives outside this blueprint |

The applier respects the boundary: linkedAssets never INSERT new rows. If a `linkedAsset`'s target row doesn't exist, the link is skipped with a warning — never silently created.

### Identity vs settings

Identity fields live at the top of the scene block (`id`, `parentId`, `slug`, `name`, `icon`, `tint`). These are what iOS shows in the scene chrome — load-bearing for cross-references and the visual header.

`settings` carries everything that lives in the iOS settings sheet: description, feature flags, welcome suggestions, notify-on-complete. These are user-configurable per scene; the applier only touches columns the blueprint declares, so anything the iOS user has set that the blueprint doesn't carry stays intact.

### Three-way merge

Every export captures the scene's current commit hash and tree hash under `meta.exported_from`. On apply, the runner compares against the scene's *current* head and runs a real three-way merge per-asset:

| | base = blueprint's export commit |  live = scene's head right now |
|---|---|---|
| `live == base`, `incoming == base` | `no_op` | — |
| `live == base`, `incoming ≠ base` | `update` | apply incoming |
| `live ≠ base`, `incoming == base` | `keep_local` | leave row alone |
| `live ≠ base`, `incoming ≠ base`, `live == incoming` | `no_op` | same change |
| `live ≠ base`, `incoming ≠ base`, `live ≠ incoming` | **`conflict`** | refuse (`--strict`) or warn |

Under the hood: scene-store's commit chain + `buildSceneTree`'s entry hashes (`hash({state, view_config})`). Same primitives Daslab already uses for live SSE sync; the blueprint applier just exposes them as a merge gate.

---

## Reference

### Top level

| Field | Type | Required | Description |
|---|---|---|---|
| `$schema` | string | — | URL to the JSON Schema. Cosmetic — enables editor validation. |
| `version` | `1` | required | Schema version. Bumps require a migration. |
| `id` … `meta` | — | — | The scene block (see below). |

The blueprint *is* a scene block. The fields below also apply to children under `scenes[]`.

### Scene identity

```jsonc
{
  "id":          "scn_models_tracker",       // required
  "parentId":    null,                         // optional; inferred when nested
  "slug":        "models-tracker",             // optional
  "name":        "Models Tracker",             // required
  "icon":        "list.bullet.rectangle",      // SF Symbol name
  "tint":        "#4C8BF5"                     // 6-char hex, with or without `#`
}
```

#### `id`

The DB scene id. Stable across applies — never regenerated. Two accepted shapes:

- Prefixed: `scn_<base62>` — the Stripe-style id format for new scenes.
- UUID: `01234567-89ab-cdef-...` — legacy roots predating the prefix change. Accepted for backward compatibility.

#### `parentId`

When this block is **nested** under another scene's `scenes[]`, the applier sets `parentId` from context — write it explicitly only to override.

When this block is a **standalone** sub-scene blueprint (e.g. one file describing a child of an existing world), set `parentId` to the parent's id directly.

`parentId: null` (or omitted) means root scene. `is_visible_to_org` is derived: `true` for roots, `false` for children.

#### `slug`, `name`, `icon`, `tint`

Display. `slug` is URL-style; `name` is the human-readable label; `icon` is an SF Symbol; `tint` is a 6-char hex color (the `#` is optional — the applier normalizes).

---

### `settings` — the iOS settings sheet

```jsonc
"settings": {
  "description":        "Daily check for new model versions.",
  "featureFlags":       { "webViewChat": true, "debugLogging": true },
  "welcomeSuggestions": [
    { "label": "What's this for?", "prompt": "Explain this scene in 3 bullets." }
  ],
  "notifyOnComplete":   true
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `description` | string | `""` | Subtitle shown in the iOS settings sheet. Not part of identity. |
| `featureFlags` | `{ [k: string]: boolean }` | `{}` | Per-scene feature toggles. Common: `webViewChat`, `debugLogging`, `experimental`. |
| `welcomeSuggestions` | `[{ label, prompt }]` | `null` | Starter prompts shown above the input. Takes precedence over auto-defaults. |
| `notifyOnComplete` | boolean | `true` | Push notifications on job completion. Only emitted on export when explicitly `false`. |

**Apply behavior:** these write to separate DB columns. The applier only touches columns the blueprint specifies — settings the iOS user toggled that the blueprint doesn't carry are preserved.

---

### `assets[]` — scene-owned content

```jsonc
"assets": [
  {
    "id":           "intro",                          // plan-local handle
    "type":         "daslab/note",                    // asset type
    "name":         "About this scene",
    "externalId":   "intro",                          // optional; defaults to `id`
    "externalUrl":  "https://...",                    // optional
    "assetOwnerId": "ast_some_account",                // optional; parent account
    "fields":       { "content": "..." },              // type-specific
    "layout":       { "sortOrder": 0, "size": "large" }
  }
]
```

**Identity & uniqueness:**

The applier derives the DB id as `assetId(sceneId, type, externalId)`. Same inputs → same DB id, every apply. If you want two assets of the same type with the same external id in the same scene, you need different local `id` handles (and accept that one of them has `externalId: <different>`).

If `externalId` is omitted, `id` doubles as the external id. This is fine for daslab-managed types (notes, webviews) where you author the handle; for provider-managed types (github/repository, sap-s4hana/product), set `externalId` to the provider's native id (e.g. `"owner/repo"`, `"@777-200-MPL"`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | required | Plan-local handle. Used as `asset_id` in `schedules[i].anchors[]` (and elsewhere) to reference this asset. |
| `type` | string | required | Asset type, e.g. `daslab/note`, `github/repository`, `modelsdev/account`. |
| `name` | string | required | Display label. |
| `description` | string | — | Secondary line shown under the name on cards/tiles. Stored on `assets.description`. |
| `externalId` | string | — | Provider's native id. Stored on `assets.external_id`. |
| `externalUrl` | string | — | "Open in browser" target. Stored on `assets.external_url`. |
| `assetOwnerId` | string | — | DB id of the parent account asset whose credentials this asset uses. |
| `fields` | object | — | Type-specific JSON. Stored on `assets.fields`. Provider widgets render this. |
| `layout` | object | — | Scene-local placement. See [Layout](#layout). |
| `pinned` | `string[]` | — | Reserved (v1 stub) — field paths the plan always owns. See [Reserved fields](#reserved-fields). |

**Field content (`fields`)** is opaque to the format — its shape is determined by the asset's provider (e.g. `daslab/note` expects `{ content }`; `github/repository` expects `{ owner, repo }`). Refer to the provider's docs.

**`fields` values can be `$file` references** — see [`$file` resolution](#file-resolution).

---

### `linkedAssets[]` — pin existing rows

```jsonc
"linkedAssets": [
  // (a) Direct DB id — for accounts and well-known constants
  { "id": "ast_sap_hana_bench",                                "layout": { "sortOrder": 99, "size": "icon" } },

  // (b) (type, externalId) — applier resolves via assetId(rootSceneId, type, externalId)
  { "type": "github/repository", "externalId": "daslab/ios2", "layout": { "sortOrder": 5, "size": "medium" } },

  // (c) Edit-in-place — UPDATE the linked row's fields/name without forking
  {
    "id":     "ast_kVO4IX89M3FT6BIS",
    "name":   "Order Book Cockpit",
    "fields": { "html": { "$file": "./cockpits/order-book.html" } },
    "layout": { "sortOrder": 1, "size": "xlarge" }
  }
]
```

**Two reference shapes:**

| Shape | Form | Resolution | Use when |
|---|---|---|---|
| Direct id | `{ "id": "ast_xxx" }` | Literal | The DB id is a known constant (account chips, hardcoded shared assets) |
| `(type, externalId)` | `{ "type": "...", "externalId": "..." }` | `assetId(rootSceneId, type, externalId)` | Portability across orgs; you want the blueprint to resolve against whatever root scene applies it |

**Optional in-place edits:**

| Field | Type | Behavior |
|---|---|---|
| `name` | string | `UPDATE assets SET name = ?` |
| `externalUrl` | string | `UPDATE assets SET external_url = ?` |
| `fields` | object | `UPDATE assets SET fields = ?::jsonb` (full replacement of the JSONB column) |
| `layout` | object | `UPSERT scene_assets.view_config` — affects the link, not the row |

When `fields` is declared, the existing row's JSONB column is replaced — the DB id stays the same. This is how a blueprint can edit the content of a shared asset (like a cockpit's HTML) without forking it into a scene-local copy.

**Skip-on-missing semantics:** if the referenced row doesn't exist, the link is skipped with a warning. The applier never INSERTs into the `assets` table from this path — that would silently create a phantom row at an arbitrary id.

---

### `schedules[]` — recurring agent tasks

```jsonc
"schedules": [
  {
    "id":      "daily-sync",
    "cron":    "TZ=Europe/Berlin 0 9 * * *",
    "prompt":  "Compare modelsdev_list_providers against the snapshot. PR drift.",
    "anchors": [
      { "asset_id": "catalog" },
      { "asset_id": "repo" },
      { "asset_id": "snapshot", "anchor": "row[0]" }
    ],
    "enabled": true,
    "checks":  [
      { "op": "lte", "path": "$run.cost_usd", "value": 0.20,
        "expose": true, "severity": "fail", "why": "Daily cost cap." }
    ]
  }
]
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | required | Plan-local handle. The applier derives a deterministic `job_*` id from `(sceneId, id)`. |
| `title` | string | — | Optional display name. Defaults to `id`. |
| `cron` | string | required | Standard 5-field cron expression with optional `TZ=<IANA>` prefix. Examples: `0 6 * * *` (UTC), `TZ=Europe/Berlin 0 6 * * *` (Berlin wall-clock, DST-aware). |
| `prompt` | string | required | What the agent is asked to do each tick. Stored on the schedule template; replayed verbatim into each scheduled run. |
| `anchors` | `AnchorRef[]` | — | Optional explicit input attachments. Each entry is `{ asset_id, anchor? }` (see [Anchors](README.md#addressability--every-sub-element-is-anchorable)). Omit/empty to inherit the scene's full context. `asset_id` may be a blueprint-local handle (resolved at apply time) or a globally-unique asset id. |
| `runAs` | string | — | Role slug to scope the run's permissions. References a `roles[]` slug or built-in (`owner`/`editor`/`viewer`). |
| `tools` | object | — | Optional per-schedule `{ allow?, deny? }` override of the scene's tool scope. |
| `enabled` | boolean | `true` | Cron fires when `true`. |
| `checks` | `CheckExpr[]` | — | Live evaluations against the run. See [Checks](#checks). |

**Anchors vs scene context.** When `anchors` is omitted or empty, the scheduled run sees the scene's full visible asset set — same as an unselected interactive run. When present, the run starts with these anchors pre-attached, identical to a user pre-selecting elements before running interactively. Sub-element selectors (`row[0]`, `item[m4]`, `step[…]`, etc.) follow the [anchor grammar](README.md#addressability--every-sub-element-is-anchorable).

**Owner attribution:** the schedule's job is attributed to the first owner-role member of the scene (or any ancestor scene, inherited). If no owner is resolvable, the schedule is created but a warning is emitted.

**Idempotence:** a deterministic `job_<hash>` id is derived from `(sceneId, schedule.id)` so re-apply updates the same template in place. The recurrence rule and prompt live directly on the template — the next-fire instant is derived from `cron`.

---

### `tasks[]` — runnable scenarios

Tasks are scenebench-shaped: an `initialState` per asset + a `prompt` + an optional `checks` rubric. The runner creates a fresh **child scene** parented to this one, seeds the assets with `initialState`, fires the prompt, then evaluates checks against the post-run scene state.

```jsonc
"tasks": [
  {
    "id":   "drift-detected",
    "name": "Detect drift and open PR",
    "prompt": "Run the daily sync. Open a PR if anything changed.",
    "initialState": {
      "catalog":  { "providers_total": 87, "models_total": 1240 },
      "snapshot": { "providers_total": 85, "models_total": 1236 }
    },
    "tools": {
      "expected": ["modelsdev_list_providers", "github_create_pull_request"]
    },
    "checks": [
      {
        "op": "count", "collection": "$newAssets",
        "where": { "op": "eq", "path": "type", "value": "github/pull_request" },
        "gte": 1,
        "why": "Sync must produce a github/pull_request asset on drift."
      }
    ]
  }
]
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | required | Plan-local handle. |
| `name` | string | required | Display label. |
| `prompt` | string \| `[{role, content}]` | required | Either a plain message or a role-array (system/user/assistant). |
| `initialState` | object | — | Per-asset-handle seed data. Merged into each asset's `fields` when the task spawns its child scene. |
| `tools` | object | — | `{ allow?, deny?, expected? }`. `expected` is a grader hint, not enforcement. |
| `checks` | `CheckExpr[]` | — | Evaluated post-run. See [Checks](#checks). |
| `run` | `"ephemeral"` \| `"in_place"` | `"ephemeral"` | Spawn a new child scene (default) vs execute against the live scene. |

**Apply behavior:** tasks are **not realized at apply time**. The applier validates the shape and exits. Use `scripts/run-blueprint-task.ts` to execute one against a model.

---

### `members[]` — access grants

```jsonc
"members": [
  { "principal": "github:octocat",     "role": "owner" },
  { "principal": "email:foo@bar.com",  "role": "editor" }
]
```

Each entry has exactly one of `principal`, `email`, or `device` — plus `role`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `principal` | string | one-of | Canonical `<provider>:<identity>` form. Examples: `github:octocat`, `github:583231` (numeric user id, rename-proof), `email:foo@bar.com`, `google:<sub>`, `apple:<sub>`. The provider prefix names the auth provider; identity is unique within that provider. Use this form for new blueprints — it scales to any registered auth provider with no schema change. |
| `email` | string | one-of | Legacy alias for `principal: "email:<addr>"`. Resolves only against email-auth users. |
| `device` | string | one-of | Device slot slug. Provisioning binds physical devices to slots out-of-band. |
| `role` | `"owner"` \| `"editor"` \| `"viewer"` \| custom slug | required | Built-in role or a role declared in `roles[]`. |

Resolution dispatches by provider prefix: `email:` looks up an email-auth user, `github:` matches either a numeric `github_id` or a username among github-auth users, `google:` / `apple:` match the corresponding OIDC subject id, `device:` is provisioned out-of-band. Unknown providers warn and skip — forward-compatible with new auth providers added later.

**Inheritance:** members declared on a scene flow downward to its `scenes[]` children for the purpose of owner attribution (schedules without explicit members inherit the parent's owner). Explicit `members[]` on a child scene replaces the inherited list for that scene.

---

### `scenes[]` — child scenes

```jsonc
"scenes": [
  {
    "id":   "scn_child",
    "name": "Child",
    "icon": "cube",
    "assets": [/* ... */],
    "scenes": [
      { "id": "scn_grandchild", "name": "Grandchild" }
    ]
  }
]
```

Each entry is a full scene block (same shape as the top of the file). Nesting expresses `parentId` — write `parentId` explicitly only if you need to override.

The applier walks the tree depth-first. Roots are upserted before children, so `parentId` references always resolve.

---

### `meta` — provenance

```jsonc
"meta": {
  "author":  "Daslab",
  "license": "MIT",
  "source":  "ported from seed-sap-bench-jonathan.ts",

  "exported_from": {
    "sceneId":  "scn_models_tracker",
    "commit":   "48216badb835b1b55d3641296804a3dd",
    "treeHash": "97f1d6d4b507a9c292a3321affa44ac7",
    "at":       "2026-05-13T16:31:35.911Z"
  }
}
```

| Field | Set by | Used by |
|---|---|---|
| `author`, `license`, `source` | Author | Catalog / docs / display |
| `exported_from.sceneId` | `export-scene` CLI | — |
| `exported_from.commit` | `export-scene` CLI (from `scene-store` `heads/server` ref) | Applier — ancestry check |
| `exported_from.treeHash` | `export-scene` CLI (from `buildSceneTree`) | Applier — per-asset 3-way merge |
| `exported_from.at` | `export-scene` CLI | Display |

`meta.exported_from` enables [three-way merge](#three-way-merge) on re-apply. The applier ignores `meta` for any other purpose.

---

## Checks

`checks[]` on a `schedule` or `task` evaluates each entry via the [`autocheck`](https://github.com/daslabhq/autocheck) operator set against the post-run state. Returns `{ pass, gap, why }` per check — gap is a continuous distance-to-satisfaction (0 iff pass), useful as a heuristic in iterative agent loops.

```jsonc
{
  "op": "count",
  "collection": "$newAssets",
  "where": { "op": "eq", "path": "type", "value": "github/pull_request" },
  "gte": 1,
  "why": "Expect a PR to be opened.",
  "expose": true,
  "severity": "fail",
  "kill": true,
  "meta": { "references": ["docs/policy.md#prs"] }
}
```

| Field | Type | Notes |
|---|---|---|
| `op` | string | autocheck op: `eq`, `neq`, `gte`, `lte`, `contains`, `exists`, `missing`, `find`, `count`, `and`, `or`, `not`. |
| `path` | string | Dot-path into the state, or `$run.<key>` for live OTel attributes (`cost_usd`, `duration_seconds`, `status`). |
| `value` / `substring` / `collection` / `where` / `of` | varies | Op-specific. See autocheck docs. |
| `why` | string | Human-readable intent. Prepended to autocheck's diagnostic in reports. |
| `expose` | boolean | When `true`, the check appears in the agent's system prompt as a constraint. Default: hidden (benchmark-style). |
| `severity` | `"info"` \| `"warn"` \| `"fail"` | Defaults to `fail`. |
| `kill` | boolean | When `true` + severity `fail` + live-evaluation flips to !pass, the run aborts. |
| `meta.references` | `string[]` | Authority sources (regulations, SOPs). Modeled on Semgrep / OPA. |

**State paths the checks see:**

- `<assetHandle>` — the asset's `fields` (e.g. `findings_known.content`)
- `$run.cost_usd` — total cost of the task run in USD
- `$run.duration_seconds` — wall time
- `$run.status` — `completed | failed | timeout | skipped`
- `$newAssets[]` — flat array of any assets created in the scene during the run (each item has `id, type, name, external_id, ...fields`)

---

## `$file` resolution

Long string fields (HTML, markdown, code) can live in adjacent files, referenced by `$file`:

```jsonc
{
  "fields": {
    "html": { "$file": "./cockpits/order-book.html" },
    "content": { "$file": "./notes/intro.md" }
  }
}
```

**Resolution:** paths are relative to the blueprint file's directory. The CLI resolves them before the applier sees the document — the applier is pure, consumes already-inlined JSON.

**Reverse direction (`extract-html`):** `export-scene --extract-html` pulls any field whose value exceeds a threshold (default 500 bytes) out to a sidecar file and replaces it with a `$file` ref. File extension is chosen from the field name (`html` → `.html`, `content`/`markdown` → `.md`, `css`, `js`, `sql`, else `.txt`).

**Distribution:** a blueprint is either:

- A single `.json` file (everything inline) — fits in a gist
- A directory containing `<name>.blueprint.json` plus a sidecar folder — package as a tarball or git submodule

Both forms work identically with the applier.

---

## CLI

The reference impl lives in [`daslab/server/scripts/`](https://github.com/daslabhq/daslab/tree/main/server/scripts).

### `apply-blueprint`

```bash
bun run scripts/apply-blueprint.ts <path> [--strict]
```

Idempotent. Reads `meta.exported_from.commit` and runs the merge check. Without `--strict`, conflicts produce warnings and the apply proceeds (incoming-wins for now). With `--strict`, conflicts throw before any DB write.

### `export-scene`

```bash
bun run scripts/export-scene.ts <sceneId> [--out=path] [--children] [--meta] [--extract-html] [--extract-threshold=500]
```

Materializes a fresh scene tree at export time so the base tree blob is guaranteed in scene-store for the next apply's three-way merge. `--children` walks `parent_id` to embed sub-scenes. `--extract-html` writes large string fields to adjacent files.

### `run-blueprint-task`

```bash
DASLAB_TOKEN=dk_xxx bun run scripts/run-blueprint-task.ts <blueprint> <task-id> [--model=...]
```

Creates a fresh child scene parented to the blueprint scene, clones assets with `initialState` merged into `fields`, POSTs `/api/jobs` against the child, polls to completion, evaluates checks against the post-run state, writes a summary asset back to the run scene.

---

## Three-way merge

Every export captures `meta.exported_from = { commit, treeHash }` — the scene's head at the moment of export. On apply, two layers run before any DB write:

### Layer 1 — commit ancestry

`clean` | `behind` | `diverged` | `no_base` | `no_head`

The applier walks the scene's commit chain backward (bounded at 200 commits) looking for the blueprint's base commit:

| Outcome | Meaning | Default behavior | `--strict` |
|---|---|---|---|
| `clean` | head == base | Apply normally | Apply |
| `behind` | base is in head's history (live moved ahead) | Warn, apply | Refuse |
| `diverged` | base not in chain (rewritten or replaced) | Warn, apply | Refuse |
| `no_base` | blueprint has no `meta.exported_from.commit` | Apply blind | Apply blind |
| `no_head` | scene has no commits yet | Apply blind | Apply blind |

### Layer 2 — per-asset three-way

Loads the base tree from `scene-store` (skipped if GC'd → degraded mode). Computes entry hashes for live and incoming using the same `hashContent({ state, view_config })` formula `buildSceneTree` uses. Classifies per asset:

| Asset state | Action |
|---|---|
| base = live = incoming | `no_op` |
| live unchanged, incoming changed | `update` |
| live changed, incoming unchanged | `keep_local` |
| live and incoming both changed, same target | `no_op` |
| live and incoming both changed, different targets | **`conflict`** |
| in base+live, not incoming | `delete` if live == base, else `conflict` |
| in base+incoming, not live | `no_op` if incoming == base, else `conflict` |
| in live+incoming, not base (both added) | `no_op` if equal, else `conflict` |
| in base only | `no_op` |
| in incoming only | `add` |
| in live only | `keep_local` |

Conflicts surface in the apply report. `--strict` throws; default warns and proceeds.

**Apply path is still incoming-wins.** The 3-way layer is currently a *gate*, not a *resolver* — it catches "your apply would clobber N edits" before writes happen. Per-field auto-merge with conflict markers is planned for v1.x.

---

## Patterns

Each pattern is built from primitives above. Reference blueprints live in [`docs/examples/`](./examples/) and in the [`daslab` repo](https://github.com/daslabhq/daslab/tree/main/server/scenes).

### Catalog sync (Models Tracker)

A scene that watches an external catalog and produces findings notes on a schedule.

```
assets: [catalog (modelsdev/account), tracked (note), findings (note)]
schedules: [{ cron, prompt: "compare catalog to tracked, write findings" }]
tasks: [{ id: "drift-detected", checks: [contains(today's date)] }]
```

### Demo workspace (SAP Bench)

A root scene with N sub-scenes, each with its own dashboard layout. Cockpit HTML lives in `$file` sidecars; provider entities (products, POs, channels) come from `linkedAssets` so they shadow the existing rows in the original workspace.

```
scenes: [
  { id: "...", linkedAssets: [<account chips>, <products>, <channel>],
    assets: [<intro note>, <cockpit webview>, <queries>] },
  ...
]
```

### Edit-in-place loop

Branch a live scene → edit cockpit HTML offline → merge back.

```bash
bun run scripts/export-scene.ts <id> --extract-html --out=./mine.blueprint.json
$EDITOR ./mine/<asset>.html
bun run scripts/apply-blueprint.ts ./mine.blueprint.json --strict
```

The `linkedAsset` carrying the cockpit HTML edits in place — same DB id, content replaced, no fork.

---

## Reserved fields

These exist in the v1 schema but the v1 applier ignores them. Documenting their shape now so when v1.x implements them, the schema doesn't change.

| Field | Shape | Will do |
|---|---|---|
| `inputs` | `{ [id]: { type, default?, required?, description? } }` | Parameterize blueprints. `${inputs.X}` interpolation across the document at apply time. |
| `secrets` | `{ [id]: { from: "vault:..." \| "env:..." } }` | Resolve secrets at apply time. `${secrets.X}` interpolation. |
| `extends` | `string \| string[]` | Base blueprint(s) this one inherits. USD-style composition. |
| `hooks` | `{ on_<event>: string[] }` | Lifecycle hooks — list of tool names to invoke on events like `job_completed`, `check_failed`. |
| `outputs` | `{ [id]: { from: "<jsonpath>" } }` | Named projections from scene state, consumable by other blueprints. |
| `asset.pinned` | `string[]` | Field paths the plan always owns; user edits to these get discarded on re-apply. Wired into the v2 three-way resolver. |

Future v1.x ships these as additive features. A v1 blueprint that uses none of them remains valid forever.

---

## Stability and versioning

| Tag | Means |
|---|---|
| `v1.0` | Current. Schema URL: `https://daslab.dev/schemas/scene-blueprint-v1.json`. |
| `v1.x` | Additive only. Reserved fields get implementations; new optional fields may appear. No renames. |
| `v2` | Breaking changes. Migration tooling will ship with it. |

**Compatibility commitments:**

- Existing v1 blueprints will validate against v1.x schemas indefinitely.
- The applier guarantees that fields the blueprint *doesn't* mention are not modified on apply — adding new top-level fields in v1.x doesn't risk old DBs being touched.
- `meta.exported_from` is preserved across versions; merge semantics are stable.

**What may change in v1.x without notice:**

- Reserved-field semantics (since they're parsed-but-ignored today).
- CLI flag names (the CLI is a reference impl, not a spec).
- Three-way merge's `apply` action set may grow (e.g. `merged_field`, `merged_partial`) — these would be additive to `ApplyResult.threeWay.plan[].action`.

---

## See also

- [`scenecast`](../README.md) — the asset definition API. Asset `type` values come from here.
- [`autocheck`](https://github.com/daslabhq/autocheck) — the JSON-grade-language used in `checks[]`.
- [`scene-otel`](https://github.com/daslabhq/scene-otel) — runtime snapshot wire format. `scene.set` events emitted *during* an apply trace the diff blueprint → DB.
- [`scenebench`](https://github.com/daslabhq/scenebench) — runs `tasks[]` at scale, produces leaderboards.
- [`autocompile`](https://github.com/mirkokiefer/autocompile) — observes repeated apply runs and compiles the invariant parts into code.

---

## Contributing

Schema lives in this repo at [`schemas/scene-blueprint-v1.json`](../schemas/scene-blueprint-v1.json). The reference implementation (applier, exporter, runner, three-way merge) lives in [`daslab/server/src/lib/scene-blueprint/`](https://github.com/daslabhq/daslab/tree/main/server/src/lib/scene-blueprint).

Schema PRs need a migration story for any non-additive change. Applier PRs need a round-trip test (export → apply → re-export → equal).
