import type { DesignDoc, PatchOp } from '@design4/design-doc';

/** Turn-history voor multi-turn conversation. Oudste eerst. */
export type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type AIContext = {
  doc: DesignDoc;
  /** Currently selected node in the canvas, if any. */
  selectedNodeId?: string;
  /**
   * Optional chat-history voor multi-turn context. Excludes de huidige
   * prompt (die gaat als tweede arg naar generatePatch). Adapters die
   * multi-turn ondersteunen (ClaudeAIAdapter) sturen dit mee; adapters
   * die het niet snappen (MockAIAdapter) negeren het.
   */
  history?: ChatTurn[];
};

export type AIResponse = {
  assistantMessage: string;
  patches: PatchOp[];
};

export interface AIAdapter {
  readonly name: string;
  generatePatch(context: AIContext, prompt: string): Promise<AIResponse>;
}
