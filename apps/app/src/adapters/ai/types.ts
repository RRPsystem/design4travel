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

/**
 * Live-events uit een streaming AI-call. Elk event correspondeert met een
 * echte upstream-gebeurtenis (Anthropic-stream-event of route-beslissing).
 * NOOIT fake events voor UX-fluff (zie project-no-fake-ux memory).
 * Optionele callback naar generatePatch — adapters die niet streamen (Mock)
 * negeren de callback.
 */
export type AIStreamEvent =
  /** Actief model gewisseld (initieel router, na delegate → specialist). */
  | { kind: 'model_change'; model: string }
  /** Text-delta uit de assistant-message. UI concatteert. */
  | { kind: 'text_delta'; text: string }
  /** Nieuwe tool_use-call gestart bij Anthropic. Naam bekend, args nog niet volledig. */
  | { kind: 'tool_start'; index: number; tool: string }
  /** Tool_use volledig binnen. summary = korte NL-omschrijving. */
  | { kind: 'tool_complete'; index: number; tool: string; summary: string }
  /** Router delegate'de naar specialist. UI toont visuele transitie. */
  | { kind: 'delegate'; from: string; to: string; rationale: string };

export interface AIAdapter {
  readonly name: string;
  generatePatch(
    context: AIContext,
    prompt: string,
    onEvent?: (event: AIStreamEvent) => void,
  ): Promise<AIResponse>;
}
