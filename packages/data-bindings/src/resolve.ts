/**
 * Resolves a bind-path like "accommodation.name" against a Studio4Model.
 * Returns undefined when any segment is missing; the caller decides on fallback.
 */
export function resolveBinding(model: unknown, path: string): unknown {
  const segs = path.split('.');
  let cur: unknown = model;
  for (const seg of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
