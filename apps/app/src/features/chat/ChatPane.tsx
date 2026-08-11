import { useDesignDocStore } from '../../state/designDocStore.js';
import { MessageList } from './MessageList.js';
import { PromptInput } from './PromptInput.js';

interface Props {
  onOpenVersionHistory(): void;
}

export function ChatPane({ onOpenVersionHistory }: Props) {
  const undo = useDesignDocStore((s) => s.undo);
  const redo = useDesignDocStore((s) => s.redo);
  const stack = useDesignDocStore((s) => s.stack);
  const saveState = useDesignDocStore((s) => s.saveState);
  const lastError = useDesignDocStore((s) => s.lastError);

  return (
    <div
      style={{
        width: 420,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid #e5e7eb',
        background: '#fff',
      }}
    >
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 14 }}>design4.travel</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: saveStateColor(saveState) }}>{saveStateLabel(saveState)}</span>
          <button
            type="button"
            onClick={onOpenVersionHistory}
            title="Versiegeschiedenis"
            style={btn(true)}
          >
            Versies
          </button>
          <button
            type="button"
            onClick={() => undo()}
            disabled={stack.past.length === 0}
            title="Ongedaan maken"
            style={btn(stack.past.length > 0)}
          >
            ↶
          </button>
          <button
            type="button"
            onClick={() => redo()}
            disabled={stack.future.length === 0}
            title="Opnieuw"
            style={btn(stack.future.length > 0)}
          >
            ↷
          </button>
        </div>
      </div>
      {lastError ? (
        <div
          style={{
            fontSize: 12,
            color: '#991b1b',
            background: '#fee2e2',
            padding: '6px 12px',
            borderBottom: '1px solid #f87171',
          }}
        >
          {lastError}
        </div>
      ) : null}
      <MessageList />
      <PromptInput />
    </div>
  );
}

function btn(enabled: boolean) {
  return {
    background: 'transparent',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 14,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.4,
  };
}

function saveStateLabel(s: string) {
  switch (s) {
    case 'saving':
      return 'Opslaan…';
    case 'saved':
      return 'Opgeslagen';
    case 'error':
      return 'Fout';
    default:
      return '';
  }
}

function saveStateColor(s: string) {
  switch (s) {
    case 'saving':
      return '#6b7280';
    case 'saved':
      return '#16a34a';
    case 'error':
      return '#dc2626';
    default:
      return '#6b7280';
  }
}
