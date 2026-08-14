import { useCallback, useMemo } from 'react';
import { getAI } from '../../adapters/ai/registry.js';
import { useChatStore } from '../../state/chatStore.js';
import { useDesignDocStore } from '../../state/designDocStore.js';

export function useChatController() {
  const busy = useChatStore((s) => s.busy);
  const append = useChatStore((s) => s.append);
  const setBusy = useChatStore((s) => s.setBusy);

  const sendPrompt = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      append({ role: 'user', text: trimmed });
      setBusy(true);
      try {
        const { doc, selectedNodeId } = useDesignDocStore.getState();
        const response = await getAI().generatePatch({ doc, selectedNodeId }, trimmed);
        if (response.patches.length > 0) {
          useDesignDocStore.getState().applyOps(response.patches);
        }
        append({ role: 'assistant', text: response.assistantMessage });
      } catch (e) {
        append({ role: 'assistant', text: `Er ging iets mis: ${String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [append, busy, setBusy],
  );

  return useMemo(() => ({ sendPrompt, busy }), [sendPrompt, busy]);
}
