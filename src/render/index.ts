/**
 * Renderers for WidgetData. One JSON shape, multiple output formats.
 */

export { renderHTML }                    from "./html.js";
export { renderMarkdown }                from "./markdown.js";
export type { RenderOpts }               from "./markdown.js";
export { renderText }                    from "./text.js";
export { renderA2UI, toA2UIJSONL }       from "./a2ui.js";
export type {
  A2UIMessage, A2UICreateSurface, A2UIUpdateComponents, A2UIDeleteSurface,
  A2UIComponent, RenderA2UIOpts,
} from "./a2ui.js";
export { renderMCPApp }                  from "./mcp_apps.js";
export type { MCPAppResource, RenderMCPAppOpts } from "./mcp_apps.js";
