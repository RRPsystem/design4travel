import type { AIAdapter } from './types.js';
import { MockAIAdapter } from './mockAI.js';

/**
 * Module-level AI-adapter registry. `useChatController` reads via `getAI()`.
 *
 * Default is `MockAIAdapter` zodat tests + first-mount werken zonder setup.
 * `AuthedApp` roept `attachAI(new ClaudeAIAdapter(...))` na een succesvolle
 * bootstrap zodat productie-chat via de Edge Function loopt.
 */
let current: AIAdapter = new MockAIAdapter();

export function attachAI(adapter: AIAdapter): void {
  current = adapter;
}

export function getAI(): AIAdapter {
  return current;
}

/** Test-only: zet terug op de mock. */
export function resetAI(): void {
  current = new MockAIAdapter();
}
