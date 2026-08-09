import { useState, type KeyboardEvent } from 'react';
import { useDesignDocStore } from '../../state/designDocStore.js';
import { useChatController } from './useChatController.js';

export function PromptInput() {
  const [text, setText] = useState('');
  const { sendPrompt, busy } = useChatController();
  const selectedNodeId = useDesignDocStore((s) => s.selectedNodeId);
  const doc = useDesignDocStore((s) => s.doc);

  const selectedNode = selectedNodeId
    ? findNode(doc?.pages?.[0]?.root, selectedNodeId)
    : undefined;

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await sendPrompt(t);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div style={{ borderTop: '1px solid #e5e7eb', padding: 12, background: '#fff' }}>
      {selectedNode ? (
        <div
          style={{
            fontSize: 12,
            color: '#4f46e5',
            background: '#eef2ff',
            padding: '4px 8px',
            borderRadius: 6,
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>
            geselecteerd: <strong>{selectedNode.type}</strong>{' '}
            <span style={{ color: '#6b7280' }}>#{selectedNode.id}</span>
          </span>
          <button
            type="button"
            onClick={() => useDesignDocStore.getState().select(undefined)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#4f46e5',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            ✕
          </button>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Praat met AI over je ontwerp… (Enter = versturen, Shift+Enter = nieuwe regel)"
          rows={2}
          style={{
            flex: 1,
            fontSize: 14,
            fontFamily: 'inherit',
            padding: 8,
            border: '1px solid #d1d5db',
            borderRadius: 6,
            resize: 'vertical',
            minHeight: 44,
          }}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || text.trim().length === 0}
          style={{
            background: '#4f46e5',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '0 16px',
            fontSize: 14,
            fontWeight: 600,
            cursor: busy || text.trim().length === 0 ? 'not-allowed' : 'pointer',
            opacity: busy || text.trim().length === 0 ? 0.5 : 1,
          }}
        >
          Verstuur
        </button>
      </div>
    </div>
  );
}

function findNode(
  node: { id: string; type: string; children?: unknown[] } | undefined,
  id: string,
): { id: string; type: string } | undefined {
  if (!node) return undefined;
  if (node.id === id) return { id: node.id, type: node.type };
  if (!Array.isArray(node.children)) return undefined;
  for (const c of node.children as { id: string; type: string; children?: unknown[] }[]) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return undefined;
}
