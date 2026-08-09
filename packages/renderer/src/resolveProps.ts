import { resolveBinding } from '@design4/data-bindings';
import type { DesignDoc, NodeInstance, OutputFormat } from '@design4/design-doc';
import type { NodeDefinition } from '@design4/typed-nodes';

/**
 * Merges base props + per-output overrides, resolves bind-slots against the
 * data model, substitutes brand-token references ({brand.primary}), and
 * validates the final props via the node's own Zod schema.
 *
 * If validation fails we return the schema's default output plus the
 * validation error so the renderer can decide how to display a fallback.
 */
export function resolveProps(
  node: NodeInstance,
  output: OutputFormat,
  doc: DesignDoc,
  dataModel: unknown,
  def: NodeDefinition,
): { props: Record<string, unknown>; error?: string } {
  const baseProps = { ...(node.props ?? {}) };
  const baseBind = { ...(node.bind ?? {}) };

  const override = node.overrides?.[output];
  const merged: Record<string, unknown> = { ...baseProps, ...(override?.props ?? {}) };
  const binds: Record<string, string> = { ...baseBind, ...(override?.bind ?? {}) };

  for (const [key, path] of Object.entries(binds)) {
    const value = resolveBinding(dataModel, path);
    if (value !== undefined) merged[key] = value;
  }

  substituteTokens(merged, doc.brandTokens);

  const parsed = def.propsSchema.safeParse(merged);
  if (parsed.success) {
    return { props: parsed.data as Record<string, unknown> };
  }

  const defaults = def.propsSchema.safeParse({});
  return {
    props: (defaults.success ? (defaults.data as Record<string, unknown>) : merged),
    error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
  };
}

function substituteTokens(
  props: Record<string, unknown>,
  tokens: Record<string, string> | undefined,
) {
  if (!tokens) return;
  for (const [k, v] of Object.entries(props)) {
    if (typeof v !== 'string') continue;
    const match = /^\{([^}]+)\}$/.exec(v);
    if (!match) continue;
    const tokenKey = match[1]!;
    const resolved = tokens[tokenKey];
    if (resolved !== undefined) props[k] = resolved;
  }
}
