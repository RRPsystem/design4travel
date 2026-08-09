import type { ReactNode } from 'react';
import type { DesignDoc, OutputFormat } from '@design4/design-doc';
import { webTarget } from './targets/web.js';
import { NotImplementedError, type RenderContext, type TargetAdapter } from './types.js';

const registry: Partial<Record<OutputFormat, TargetAdapter>> = {
  web: webTarget,
};

/**
 * Render the doc for the requested output format.
 * Fase 1: only 'web'. Other formats throw NotImplementedError so callers get
 * an actionable, non-silent failure.
 */
export function renderTarget(
  output: OutputFormat,
  doc: DesignDoc,
  ctx: RenderContext,
): ReactNode {
  const adapter = registry[output];
  if (!adapter) throw new NotImplementedError(output);
  return adapter.renderRoot(doc, ctx);
}

export function registerTarget(adapter: TargetAdapter): void {
  registry[adapter.output] = adapter;
}
