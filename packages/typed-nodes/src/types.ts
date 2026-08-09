import type { z } from 'zod';

/** A bind slot on a node — which prop can be bound to which model path. */
export type BindSlot = {
  key: string;
  label: string;
  /** Optional filter on the value shape the resolver returns. */
  expects?: 'string' | 'number' | 'image' | 'boolean';
};

/**
 * NodeDefinition is the source-of-truth for a typed node.
 * The renderer looks up the definition to validate props and render the node.
 *
 * `propsSchema` is any Zod schema — narrow the concrete type at the node
 * declaration via `z.infer<typeof mySchema>` when useful, but we don't carry
 * the generic through here (Zod input/output split makes that painful for
 * schemas with `.default()`).
 */
export type NodeDefinition = {
  type: string;
  /** Human label for pickers */
  label: string;
  /** 'builtin' in fase 1; 'custom' reserved for later Develop-mode-registered nodes. */
  source: 'builtin' | 'custom';
  /** Scope for custom nodes (brand/agent); undefined for built-ins. */
  scope?: { kind: 'brand' | 'agent'; id: string };
  /** Zod schema — validates and gives defaults for node.props. */
  propsSchema: z.ZodTypeAny;
  /** Which prop-keys can be bind-driven from the Studio4 data model. */
  bindSlots: BindSlot[];
  /** Whether this node can contain children. */
  acceptsChildren: boolean;
};

/** Registry lookup — kept small and framework-free. */
export interface NodeRegistry {
  register(def: NodeDefinition): void;
  lookup(type: string): NodeDefinition | undefined;
  list(): NodeDefinition[];
}

export class InMemoryNodeRegistry implements NodeRegistry {
  private defs = new Map<string, NodeDefinition>();

  register(def: NodeDefinition): void {
    this.defs.set(def.type, def);
  }

  lookup(type: string): NodeDefinition | undefined {
    return this.defs.get(type);
  }

  list(): NodeDefinition[] {
    return Array.from(this.defs.values());
  }
}
