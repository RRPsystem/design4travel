import type { ReactNode } from 'react';
import type { DesignDoc, NodeInstance, OutputFormat } from '@design4/design-doc';
import type { NodeRegistry } from '@design4/typed-nodes';

export type SelectionHandler = (info: { nodeId: string; nodeType: string }) => void;

export type RenderContext = {
  registry: NodeRegistry;
  /** Studio4-datamodel used to resolve bind-slots. */
  dataModel: unknown;
  /** Currently selected node in the canvas, for visual highlight. */
  selectedNodeId?: string;
  /** Called when the user clicks a node in the canvas. */
  onSelect?: SelectionHandler;
};

/**
 * Minimal contract every output-format renderer implements.
 * Fase 1: only 'web'. Future: 'pdf', 'image', later 'docx'.
 */
export type TargetAdapter = {
  output: OutputFormat;
  renderRoot(doc: DesignDoc, ctx: RenderContext): ReactNode;
  renderNode(node: NodeInstance, doc: DesignDoc, ctx: RenderContext): ReactNode;
};

export class NotImplementedError extends Error {
  constructor(output: OutputFormat) {
    super(`Renderer for output "${output}" is not implemented yet.`);
    this.name = 'NotImplementedError';
  }
}
