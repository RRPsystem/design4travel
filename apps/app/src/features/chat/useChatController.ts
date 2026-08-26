import { useCallback, useMemo } from 'react';
import { getAI } from '../../adapters/ai/registry.js';
import type { ChatTurn } from '../../adapters/ai/types.js';
import { useChatStore, type ChatMessage } from '../../state/chatStore.js';
import { useDesignDocStore } from '../../state/designDocStore.js';

// Max chat-turns die we als context meesturen. Aligned met MAX_HISTORY_MESSAGES
// in de Edge Function (20). De welkomst-message (id='welcome') is een canned
// intro-tekst, geen echte turn — die filteren we eruit.
const MAX_HISTORY = 20;

function buildHistory(messages: ChatMessage[]): ChatTurn[] {
  const real = messages.filter((m) => m.id !== 'welcome' && m.text.trim().length > 0);
  const tail = real.slice(-MAX_HISTORY);
  return tail.map((m) => ({ role: m.role, content: m.text }));
}

export function useChatController() {
  const busy = useChatStore((s) => s.busy);
  const append = useChatStore((s) => s.append);
  const setBusy = useChatStore((s) => s.setBusy);

  const sendPrompt = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      // Snapshot history VÓÓR de user-message toe te voegen — de current
      // prompt gaat als 2e arg naar generatePatch, niet in history.
      const historyBefore = buildHistory(useChatStore.getState().messages);
      append({ role: 'user', text: trimmed });
      setBusy(true);
      // Init live-activity BEFORE de call. Model wordt initieel op '?' gezet —
      // het echte model komt binnen als eerste event (model_change). Zolang
      // dat er nog niet is, toont de UI een neutrale "denkt na..." zonder
      // model-label. Zodra Anthropic's stream begint volgt de echte model-naam.
      useChatStore.getState().startLive('');
      try {
        const { doc, selectedNodeId } = useDesignDocStore.getState();
        const response = await getAI().generatePatch(
          { doc, selectedNodeId, history: historyBefore },
          trimmed,
          (evt) => {
            useChatStore.getState().liveEvent(evt);
          },
        );
        // Succesmelding hangt aan het WERKELIJKE resultaat van applyOps,
        // niet aan `response.assistantMessage` — dat is de tekst die het
        // model wilde tonen maar dat zegt niks over of de patch daadwerkelijk
        // iets veranderde of überhaupt geldig was.
        const result =
          response.patches.length > 0
            ? useDesignDocStore.getState().applyOps(response.patches)
            : ({ ok: true, changed: false, reason: 'no-op' } as const);

        if (result.ok && result.changed) {
          append({ role: 'assistant', text: response.assistantMessage });
        } else if (result.ok && !result.changed) {
          append({
            role: 'assistant',
            text: 'Dit stond al zo ingesteld, daarom heb ik niets aangepast.',
          });
        } else {
          append({
            role: 'assistant',
            text: `Ik kon de wijziging niet uitvoeren: ${result.message}`,
          });
        }
      } catch (e) {
        append({ role: 'assistant', text: `Er ging iets mis: ${String(e)}` });
      } finally {
        useChatStore.getState().endLive();
        setBusy(false);
      }
    },
    [append, busy, setBusy],
  );

  return useMemo(() => ({ sendPrompt, busy }), [sendPrompt, busy]);
}
