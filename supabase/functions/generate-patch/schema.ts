import { z } from "zod";

// -----------------------------------------------------------------------------
// Bounds
// -----------------------------------------------------------------------------

// Prompt-body is klein (paar KB tekst + geen doc — die halen we server-side
// uit project_documents). 16 KB is ruim voldoende.
export const MAX_REQUEST_BODY_BYTES = 16_384;

export const PROMPT_MAX_CHARS = 4000;

// Max chat-turns die de client mag meesturen als context. Ver boven het
// gemiddelde exchange-aantal per sessie, laag genoeg om runaway te vermijden.
export const MAX_HISTORY_MESSAGES = 20;

// -----------------------------------------------------------------------------
// Request / Response
// -----------------------------------------------------------------------------

const HistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(PROMPT_MAX_CHARS),
}).strict();

export const GenerateRequestSchema = z.object({
  project_document_id: z.string().uuid(),
  selected_node_id: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(PROMPT_MAX_CHARS),
  // Chat-history voor multi-turn conversation. Oudste eerst. Excludes de
  // huidige prompt (die staat in `prompt`). Als weggelaten of leeg: single-turn.
  history: z.array(HistoryMessageSchema).max(MAX_HISTORY_MESSAGES).optional(),
}).strict();
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

// PatchOp — 1-op-1 identiek aan `PatchOp` uit packages/design-doc/src/patch.ts.
// Als daar een nieuwe variant bijkomt: UPDATE HIER OOK.
const NodeInstanceSchema: z.ZodType<{
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: unknown[];
  bind?: Record<string, string>;
}> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    props: z.record(z.unknown()),
    children: z.array(z.lazy(() => NodeInstanceSchema)).optional(),
    bind: z.record(z.string()).optional(),
  })
);

const PageSchemaLike = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  root: NodeInstanceSchema,
});

export const PatchOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setProp"), nodeId: z.string().min(1), key: z.string().min(1), value: z.unknown() }),
  z.object({ kind: z.literal("setProps"), nodeId: z.string().min(1), props: z.record(z.unknown()) }),
  z.object({ kind: z.literal("setBind"), nodeId: z.string().min(1), key: z.string().min(1), path: z.string().nullable() }),
  z.object({ kind: z.literal("reorderChildren"), parentId: z.string().min(1), order: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("insertNode"), parentId: z.string().min(1), index: z.number().int().min(0), node: NodeInstanceSchema }),
  z.object({ kind: z.literal("removeNode"), nodeId: z.string().min(1) }),
  z.object({ kind: z.literal("setBrandToken"), key: z.string().min(1), value: z.string() }),
  // Page-level ops (1-op-1 met packages/design-doc/src/patch.ts)
  z.object({ kind: z.literal("addPage"), page: PageSchemaLike, index: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal("removePage"), pageId: z.string().min(1) }),
  z.object({ kind: z.literal("renamePage"), pageId: z.string().min(1), name: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("reorderPages"), order: z.array(z.string()).min(1) }),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const GenerateResponseSchema = z.object({
  assistantMessage: z.string(),
  patches: z.array(PatchOpSchema),
}).strict();
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// -----------------------------------------------------------------------------
// CORS + JSON helpers
// -----------------------------------------------------------------------------

export const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

// -----------------------------------------------------------------------------
// Anthropic tool-definitions (JSON schema)
// -----------------------------------------------------------------------------
//
// Elk tool mapt 1-op-1 op een PatchOp-variant. `delegate_to_opus` is de
// uitzondering — daar intercept de handler en verstuurt hij naar Opus.
//
// Node-shape voor insert_node is expres los (additionalProperties: true) omdat
// Claude verschillende node-types moet kunnen construeren (hero, text, cta, ...).
// Client-side Zod-validatie via DesignDocSchema vangt malformed nodes op.

export const TOOL_SET_PROP = {
  name: "set_prop",
  description:
    "Set a single prop on an existing node. Use this for style/text/property tweaks like changing a title, color, size, or href. Prefer this over set_props for a single-key change.",
  input_schema: {
    type: "object",
    properties: {
      nodeId: { type: "string", description: "id of the target node" },
      key: { type: "string", description: "prop key to set" },
      value: { description: "new value (string, number, boolean, object, etc)" },
    },
    required: ["nodeId", "key", "value"],
    additionalProperties: false,
  },
} as const;

export const TOOL_SET_PROPS = {
  name: "set_props",
  description:
    "Set multiple props on an existing node in one operation. Use when you want to change 2+ props of the same node (e.g. color AND textColor of a CTA).",
  input_schema: {
    type: "object",
    properties: {
      nodeId: { type: "string" },
      props: { type: "object", additionalProperties: true },
    },
    required: ["nodeId", "props"],
    additionalProperties: false,
  },
} as const;

export const TOOL_SET_BIND = {
  name: "set_bind",
  description:
    "Bind a prop to a data path in the Studio4Model (e.g. 'trip.title'), or unbind by passing null. Only use if the user explicitly references dynamic data.",
  input_schema: {
    type: "object",
    properties: {
      nodeId: { type: "string" },
      key: { type: "string" },
      path: { type: ["string", "null"] },
    },
    required: ["nodeId", "key", "path"],
    additionalProperties: false,
  },
} as const;

export const TOOL_REORDER_CHILDREN = {
  name: "reorder_children",
  description:
    "Reorder the children of a parent node. `order` must be a permutation of the current children ids.",
  input_schema: {
    type: "object",
    properties: {
      parentId: { type: "string" },
      order: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["parentId", "order"],
    additionalProperties: false,
  },
} as const;

export const TOOL_INSERT_NODE = {
  name: "insert_node",
  description:
    "Insert a new node at the given index in the parent's children array. The `node` object must be a valid NodeInstance with a unique id, a `type` from the catalog (layout-row, layout-column, heading, text, image, hero, cta), and a `props` object appropriate for that type.",
  input_schema: {
    type: "object",
    properties: {
      parentId: { type: "string" },
      index: { type: "integer", minimum: 0 },
      node: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          props: { type: "object", additionalProperties: true },
          children: { type: "array", items: { type: "object" } },
          bind: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["id", "type", "props"],
        additionalProperties: true,
      },
    },
    required: ["parentId", "index", "node"],
    additionalProperties: false,
  },
} as const;

export const TOOL_REMOVE_NODE = {
  name: "remove_node",
  description:
    "Remove a node from the document. Cannot remove the root of a page.",
  input_schema: {
    type: "object",
    properties: {
      nodeId: { type: "string" },
    },
    required: ["nodeId"],
    additionalProperties: false,
  },
} as const;

export const TOOL_SET_BRAND_TOKEN = {
  name: "set_brand_token",
  description:
    "Set a brand token like 'brand.primary' or 'brand.accent' to a hex color. Affects all nodes that reference it via `{brand.primary}` etc.",
  input_schema: {
    type: "object",
    properties: {
      key: { type: "string" },
      value: { type: "string", description: "hex color like #4f46e5" },
    },
    required: ["key", "value"],
    additionalProperties: false,
  },
} as const;

export const TOOL_ADD_PAGE = {
  name: "add_page",
  description:
    "Add a new page to the document. Use this when the user wants a fresh page for a new subject (e.g. 'maak een golfpagina' → new page with id 'page-golf'). The `page` must have a unique `id` (not equal to any existing page id), an optional friendly `name`, and a `root` NodeInstance (typically a layout-column). `index` is optional; without it the new page appears at the end. After adding, you'll usually want to insert_node into the new page's root to populate it — emit those tool_use blocks in the same response.",
  input_schema: {
    type: "object",
    properties: {
      page: {
        type: "object",
        properties: {
          id: { type: "string", description: "unique page id, kebab-case like 'page-golf'" },
          name: { type: "string", description: "friendly display name like 'Golfreis'" },
          root: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string" },
              props: { type: "object", additionalProperties: true },
              children: { type: "array", items: { type: "object" } },
              bind: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["id", "type", "props"],
            additionalProperties: true,
          },
        },
        required: ["id", "root"],
        additionalProperties: false,
      },
      index: { type: "integer", minimum: 0, description: "optional insertion index" },
    },
    required: ["page"],
    additionalProperties: false,
  },
} as const;

export const TOOL_REMOVE_PAGE = {
  name: "remove_page",
  description:
    "Remove a page from the document. Cannot remove the only remaining page. Use when the user explicitly asks to delete a page.",
  input_schema: {
    type: "object",
    properties: {
      pageId: { type: "string" },
    },
    required: ["pageId"],
    additionalProperties: false,
  },
} as const;

export const TOOL_RENAME_PAGE = {
  name: "rename_page",
  description:
    "Rename a page (sets its `name` display label; the `id` stays the same).",
  input_schema: {
    type: "object",
    properties: {
      pageId: { type: "string" },
      name: { type: "string" },
    },
    required: ["pageId", "name"],
    additionalProperties: false,
  },
} as const;

export const TOOL_REORDER_PAGES = {
  name: "reorder_pages",
  description:
    "Reorder the pages of the document. `order` must be a permutation of ALL existing page ids.",
  input_schema: {
    type: "object",
    properties: {
      order: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["order"],
    additionalProperties: false,
  },
} as const;

export const TOOL_DELEGATE_TO_OPUS = {
  name: "delegate_to_opus",
  description:
    "Delegate this request to the more capable Opus specialist model. Use ONLY when the request is: (a) a substantial structural redesign, (b) generative work that produces multiple new nodes at once, (c) a vague creative ask that needs strong judgement (\"make it feel more premium\", \"redesign the hero\"), or (d) requires reasoning across many nodes. Do NOT delegate for simple prop tweaks, single-title changes, or reorderings — handle those directly. Provide an `enriched_prompt` that adds relevant context Opus should consider, and a short `rationale`.",
  input_schema: {
    type: "object",
    properties: {
      enriched_prompt: {
        type: "string",
        description:
          "The original user prompt, enriched with any additional context (referenced node ids, brand tokens, constraints, target audience hints) that will help Opus deliver higher-quality output.",
      },
      rationale: {
        type: "string",
        description:
          "One-sentence reason why this needed to go to Opus instead of being handled directly.",
      },
    },
    required: ["enriched_prompt", "rationale"],
    additionalProperties: false,
  },
} as const;

// Tools voor de router. `delegate_to_opus` uitsluitend op de router.
export const ROUTER_TOOLS = [
  TOOL_SET_PROP,
  TOOL_SET_PROPS,
  TOOL_SET_BIND,
  TOOL_REORDER_CHILDREN,
  TOOL_INSERT_NODE,
  TOOL_REMOVE_NODE,
  TOOL_SET_BRAND_TOKEN,
  TOOL_ADD_PAGE,
  TOOL_REMOVE_PAGE,
  TOOL_RENAME_PAGE,
  TOOL_REORDER_PAGES,
  TOOL_DELEGATE_TO_OPUS,
] as const;

// Tools voor de specialist. Geen delegate — Opus mag niet terug-delegateren
// (voorkomt oneindige lussen en dubbele-billing).
export const SPECIALIST_TOOLS = [
  TOOL_SET_PROP,
  TOOL_SET_PROPS,
  TOOL_SET_BIND,
  TOOL_REORDER_CHILDREN,
  TOOL_INSERT_NODE,
  TOOL_REMOVE_NODE,
  TOOL_SET_BRAND_TOKEN,
  TOOL_ADD_PAGE,
  TOOL_REMOVE_PAGE,
  TOOL_RENAME_PAGE,
  TOOL_REORDER_PAGES,
] as const;

// -----------------------------------------------------------------------------
// Tool-call → PatchOp conversion
// -----------------------------------------------------------------------------

export interface DelegateRequest {
  kind: "delegate";
  enriched_prompt: string;
  rationale: string;
}

export type ToolCallResult =
  | { kind: "patch"; op: PatchOp }
  | DelegateRequest
  | { kind: "unknown"; toolName: string };

export function toolCallToPatch(
  toolName: string,
  rawInput: unknown,
): ToolCallResult {
  if (toolName === "delegate_to_opus") {
    const parsed = z.object({
      enriched_prompt: z.string().min(1).max(8000),
      rationale: z.string().min(1).max(500),
    }).safeParse(rawInput);
    if (!parsed.success) return { kind: "unknown", toolName };
    return { kind: "delegate", enriched_prompt: parsed.data.enriched_prompt, rationale: parsed.data.rationale };
  }

  const opKind = TOOL_NAME_TO_OP_KIND[toolName];
  if (!opKind) return { kind: "unknown", toolName };

  const withKind = { kind: opKind, ...(rawInput as Record<string, unknown>) };
  const parsed = PatchOpSchema.safeParse(withKind);
  if (!parsed.success) return { kind: "unknown", toolName };
  return { kind: "patch", op: parsed.data };
}

const TOOL_NAME_TO_OP_KIND: Readonly<Record<string, PatchOp["kind"]>> = Object.freeze({
  set_prop: "setProp",
  set_props: "setProps",
  set_bind: "setBind",
  reorder_children: "reorderChildren",
  insert_node: "insertNode",
  remove_node: "removeNode",
  set_brand_token: "setBrandToken",
  add_page: "addPage",
  remove_page: "removePage",
  rename_page: "renamePage",
  reorder_pages: "reorderPages",
});

// -----------------------------------------------------------------------------
// Client-facing SSE-events (van Edge Function naar browser)
// -----------------------------------------------------------------------------

/**
 * Genormaliseerde event-shapes die de Edge Function als SSE naar de client
 * stuurt. Elk event hoort te corresponderen met een echte upstream-gebeurtenis
 * (Anthropic stream-event of onze eigen route-beslissing). NOOIT fake events
 * voor UX-fluff — zie project-no-fake-ux memory.
 */
export type ClientStreamEvent =
  /** Actief model gewisseld (initieel router-model, na delegate → specialist). */
  | { kind: "model_change"; model: string }
  /** Text-delta uit de assistant-message. Client concatteert. */
  | { kind: "text_delta"; text: string }
  /** Nieuwe tool_use-call gestart bij Anthropic. Naam bekend, args nog niet volledig. */
  | { kind: "tool_start"; index: number; tool: string }
  /** Tool_use-call volledig binnen. Summary is een korte NL-omschrijving. */
  | { kind: "tool_complete"; index: number; tool: string; summary: string }
  /**
   * Router-model heeft delegate_to_opus geëmit'ed en de Edge Function gaat
   * nu Opus starten. Client kan een visuele transitie tonen.
   */
  | { kind: "delegate"; from: string; to: string; rationale: string };

/**
 * Terminale events die de stream afsluiten.
 */
export type ClientStreamTerminal =
  | {
      kind: "done";
      assistantMessage: string;
      patches: PatchOp[];
    }
  | {
      kind: "error";
      code: string;
      message: string;
    };

/**
 * Bouw een NL-summary voor een tool_use-call op basis van naam + input.
 * Gebruikt voor de live-feed UI. Nooit fake — komt uit de daadwerkelijke
 * Anthropic-payload zodra de tool_use volledig binnen is.
 */
export function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 40): string => {
    if (v === undefined || v === null) return "";
    const str = typeof v === "string" ? v : JSON.stringify(v);
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  };
  switch (name) {
    case "set_prop":
      return `${s(input.nodeId, 20)}.${s(input.key, 20)} = ${s(input.value)}`;
    case "set_props":
      return `${s(input.nodeId, 20)}: ${Object.keys((input.props as object) ?? {}).join(", ")}`;
    case "set_bind":
      return `${s(input.nodeId, 20)}.${s(input.key, 20)} → ${s(input.path)}`;
    case "reorder_children":
      return `children van ${s(input.parentId, 30)} herordenen`;
    case "insert_node": {
      const node = (input.node as { id?: string; type?: string }) ?? {};
      return `${s(node.type, 20)} '${s(node.id, 24)}' toevoegen in ${s(input.parentId, 20)}`;
    }
    case "remove_node":
      return `${s(input.nodeId, 30)} verwijderen`;
    case "set_brand_token":
      return `${s(input.key, 20)} = ${s(input.value, 20)}`;
    case "add_page": {
      const page = (input.page as { id?: string; name?: string }) ?? {};
      return `pagina '${s(page.id, 24)}'${page.name ? ` (${s(page.name, 20)})` : ""}`;
    }
    case "remove_page":
      return `pagina ${s(input.pageId, 30)} verwijderen`;
    case "rename_page":
      return `${s(input.pageId, 20)} → '${s(input.name, 20)}'`;
    case "reorder_pages":
      return `pagina's herordenen`;
    case "delegate_to_opus":
      return s(input.rationale, 80);
    default:
      return name;
  }
}
