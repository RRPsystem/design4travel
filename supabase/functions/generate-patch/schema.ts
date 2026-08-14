import { z } from "zod";

// -----------------------------------------------------------------------------
// Bounds
// -----------------------------------------------------------------------------

// Prompt-body is klein (paar KB tekst + geen doc — die halen we server-side
// uit project_documents). 16 KB is ruim voldoende.
export const MAX_REQUEST_BODY_BYTES = 16_384;

export const PROMPT_MAX_CHARS = 4000;

// -----------------------------------------------------------------------------
// Request / Response
// -----------------------------------------------------------------------------

export const GenerateRequestSchema = z.object({
  project_document_id: z.string().uuid(),
  selected_node_id: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(PROMPT_MAX_CHARS),
}).strict();
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

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

export const PatchOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setProp"), nodeId: z.string().min(1), key: z.string().min(1), value: z.unknown() }),
  z.object({ kind: z.literal("setProps"), nodeId: z.string().min(1), props: z.record(z.unknown()) }),
  z.object({ kind: z.literal("setBind"), nodeId: z.string().min(1), key: z.string().min(1), path: z.string().nullable() }),
  z.object({ kind: z.literal("reorderChildren"), parentId: z.string().min(1), order: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("insertNode"), parentId: z.string().min(1), index: z.number().int().min(0), node: NodeInstanceSchema }),
  z.object({ kind: z.literal("removeNode"), nodeId: z.string().min(1) }),
  z.object({ kind: z.literal("setBrandToken"), key: z.string().min(1), value: z.string() }),
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
});
