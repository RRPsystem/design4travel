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
      // Streaming-transactie starten. Elke tool_complete met een patch
      // wordt tijdens de stream toegepast via applyStreamOp (live-preview);
      // op success committen we één undo-eenheid, op failure rollback.
      useDesignDocStore.getState().beginStream();
      let anyLiveApplyHappened = false;
      try {
        const { doc, selectedNodeId } = useDesignDocStore.getState();
        const response = await getAI().generatePatch(
          { doc, selectedNodeId, history: historyBefore },
          trimmed,
          (evt) => {
            useChatStore.getState().liveEvent(evt);
            // Live-apply per tool_complete. Fail-safe:
            // - Server pre-PR-1 (patch undefined) → skip, batch-apply na stream.
            // - Server delegate_to_opus / unknown / invalid input (patch=null) → skip.
            // - Individuele apply-failure → log, ga door met stream. Bolt/V0-stijl.
            if (evt.kind === 'tool_complete' && evt.patch) {
              const streamResult = useDesignDocStore.getState().applyStreamOp(evt.patch);
              if (streamResult.ok && streamResult.changed) {
                anyLiveApplyHappened = true;
              } else if (!streamResult.ok) {
                console.warn(
                  '[live-preview] applyStreamOp failed:',
                  streamResult.message,
                  'op:',
                  evt.patch,
                );
              }
            }
          },
        );

        // Commit-fase. Twee paden:
        // 1. Live-apply gebeurde → commitStream pusht 1 undo-eenheid + 1 save.
        // 2. Geen live-applies (server-pre-PR-1) → fallback op klassieke
        //    applyOps met response.patches. Backward-compat pad.
        let changed = false;
        let failureMessage: string | null = null;
        if (anyLiveApplyHappened) {
          const commit = useDesignDocStore.getState().commitStream();
          changed = commit.changed;
        } else {
          // Geen live-apply gebeurd. Rollback (no-op, doc is baseline) en val
          // terug op batch-apply zodat oude Edge Function-versies blijven werken.
          useDesignDocStore.getState().rollbackStream();
          if (response.patches.length > 0) {
            const result = useDesignDocStore.getState().applyOps(response.patches);
            if (result.ok) {
              changed = result.changed;
            } else {
              failureMessage = result.message;
            }
          }
        }

        if (failureMessage !== null) {
          append({
            role: 'assistant',
            text: `Ik kon de wijziging niet uitvoeren: ${failureMessage}`,
          });
        } else if (changed) {
          append({ role: 'assistant', text: response.assistantMessage });
        } else {
          append({
            role: 'assistant',
            text: 'Dit stond al zo ingesteld, daarom heb ik niets aangepast.',
          });
        }
      } catch (e) {
        // Stream errored mid-way. Rollback zodat doc terug op baseline is
        // (safe default; keep-partial vraagt om "resume"-UI die we nog niet
        // hebben — komt in v0.3-slice-3 iteratie-knoppen).
        useDesignDocStore.getState().rollbackStream();
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
