import type { DesignDoc, PatchOp } from '@design4/design-doc';

export type AIContext = {
  doc: DesignDoc;
  /** Currently selected node in the canvas, if any. */
  selectedNodeId?: string;
};

export type AIResponse = {
  assistantMessage: string;
  patches: PatchOp[];
};

export interface AIAdapter {
  readonly name: string;
  generatePatch(context: AIContext, prompt: string): Promise<AIResponse>;
}
