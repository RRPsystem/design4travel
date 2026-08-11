import { useCallback, useEffect, useState } from 'react';
import type { RollbackErrorCode, VersionHistoryAdapter, VersionSnapshot, VersionSummary } from '@design4/design-doc';
import { useDesignDocStore } from '../../state/designDocStore.js';
import { messageForRollbackError } from './errorMessages.js';

interface Props {
  open: boolean;
  onClose(): void;
  adapter: VersionHistoryAdapter;
  projectDocumentId: string;
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; versions: VersionSummary[] };

type PendingRestore = {
  version: VersionSummary;
  snapshot: VersionSnapshot;
};

export function VersionHistoryPanel({ open, onClose, adapter, projectDocumentId }: Props) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);

  const previewingVersion = useDesignDocStore((s) => s.previewingVersion);
  const previewVersion = useDesignDocStore((s) => s.previewVersion);
  const stopPreviewingVersion = useDesignDocStore((s) => s.stopPreviewingVersion);
  const restoreVersion = useDesignDocStore((s) => s.restoreVersion);
  const isRestoring = useDesignDocStore((s) => s.isRestoring);

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const versions = await adapter.list(projectDocumentId);
      setState({ kind: 'ready', versions });
    } catch (e) {
      setState({ kind: 'error', message: String(e) });
    }
  }, [adapter, projectDocumentId]);

  useEffect(() => {
    if (open) {
      setRestoreError(null);
      setRestoreSuccess(null);
      setPendingRestore(null);
      void refresh();
    }
  }, [open, refresh]);

  // Sluiten via Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handlePreview = useCallback(
    async (v: VersionSummary) => {
      try {
        const snapshot = await adapter.get(projectDocumentId, v.version_number);
        if (!snapshot) {
          setRestoreError(messageForRollbackError('target_version_not_found'));
          return;
        }
        previewVersion(snapshot);
        setRestoreError(null);
        setRestoreSuccess(null);
      } catch (e) {
        setRestoreError(`Kon versie niet laden: ${String(e)}`);
      }
    },
    [adapter, projectDocumentId, previewVersion],
  );

  const handleAskRestore = useCallback(
    async (v: VersionSummary) => {
      try {
        const snapshot = await adapter.get(projectDocumentId, v.version_number);
        if (!snapshot) {
          setRestoreError(messageForRollbackError('target_version_not_found'));
          return;
        }
        setPendingRestore({ version: v, snapshot });
        setRestoreError(null);
        setRestoreSuccess(null);
      } catch (e) {
        setRestoreError(`Kon versie niet laden: ${String(e)}`);
      }
    },
    [adapter, projectDocumentId],
  );

  const handleConfirmRestore = useCallback(async () => {
    if (!pendingRestore) return;
    const result = await restoreVersion(pendingRestore.snapshot);
    if (result.ok) {
      const targetNumber = pendingRestore.version.version_number;
      setRestoreSuccess(
        `Versie ${targetNumber} hersteld als nieuwe versie ${result.new_version_number}. De vorige toestand is bewaard.`,
      );
      setPendingRestore(null);
      await refresh();
    } else {
      const code: RollbackErrorCode = result.error;
      setRestoreError(messageForRollbackError(code));
      setPendingRestore(null);
    }
  }, [pendingRestore, restoreVersion, refresh]);

  if (!open) return null;

  return (
    <div style={backdrop} role="dialog" aria-modal="true" aria-label="Versiegeschiedenis" onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <header style={header}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Versiegeschiedenis</div>
          <button type="button" onClick={onClose} style={closeBtn} aria-label="Sluiten">
            ×
          </button>
        </header>

        {previewingVersion ? (
          <div style={infoBar}>
            Je bekijkt versie <strong>{previewingVersion.version_number}</strong>. De editor is
            ongewijzigd.{' '}
            <button type="button" onClick={stopPreviewingVersion} style={linkBtn}>
              Terug naar actueel
            </button>
          </div>
        ) : null}

        {restoreSuccess ? (
          <div style={successBar} role="status">
            {restoreSuccess}
          </div>
        ) : null}
        {restoreError ? (
          <div style={errorBar} role="alert">
            {restoreError}
          </div>
        ) : null}

        <div style={body}>
          {state.kind === 'loading' ? (
            <div style={muted}>Versies laden…</div>
          ) : state.kind === 'error' ? (
            <div style={muted}>Kon versies niet laden: {state.message}</div>
          ) : state.versions.length === 0 ? (
            <div style={muted}>Nog geen opgeslagen versies.</div>
          ) : (
            <ul style={list}>
              {state.versions.map((v) => {
                const isCurrentPreview =
                  previewingVersion?.version_number === v.version_number;
                return (
                  <li key={v.version_number} style={row(isCurrentPreview)}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        Versie {v.version_number}
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>
                        {formatDateTime(v.created_at)}
                        {v.author_label ? ` · ${v.author_label}` : ''}
                        {v.author_note ? ` · ${v.author_note}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => handlePreview(v)}
                        style={ghostBtn}
                        disabled={isRestoring}
                      >
                        {isCurrentPreview ? 'Bekeken' : 'Bekijken'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAskRestore(v)}
                        style={primaryBtn}
                        disabled={isRestoring}
                      >
                        Herstel
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {pendingRestore ? (
          <div style={confirmOverlay}>
            <div style={confirmBox}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                Versie {pendingRestore.version.version_number} herstellen?
              </div>
              <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>
                De huidige toestand wordt automatisch bewaard als nieuwe versie.
                Deze rollback is later ook weer ongedaan te maken door terug te keren
                naar die bewaarde versie.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setPendingRestore(null)}
                  style={ghostBtn}
                  disabled={isRestoring}
                >
                  Annuleren
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRestore}
                  style={primaryBtn}
                  disabled={isRestoring}
                >
                  {isRestoring ? 'Bezig…' : 'Herstel deze versie'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('nl-NL', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const backdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.4)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: 48,
  zIndex: 50,
};
const panel: React.CSSProperties = {
  width: 'min(560px, 90vw)',
  maxHeight: 'calc(100vh - 96px)',
  background: '#fff',
  borderRadius: 8,
  boxShadow: '0 10px 30px rgba(15,23,42,0.2)',
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  overflow: 'hidden',
};
const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid #e5e7eb',
};
const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 22,
  color: '#6b7280',
  cursor: 'pointer',
  lineHeight: 1,
  padding: 4,
};
const infoBar: React.CSSProperties = {
  padding: '8px 16px',
  background: '#eff6ff',
  color: '#1e40af',
  fontSize: 12,
  borderBottom: '1px solid #bfdbfe',
};
const successBar: React.CSSProperties = {
  padding: '8px 16px',
  background: '#ecfdf5',
  color: '#065f46',
  fontSize: 12,
  borderBottom: '1px solid #a7f3d0',
};
const errorBar: React.CSSProperties = {
  padding: '8px 16px',
  background: '#fef2f2',
  color: '#991b1b',
  fontSize: 12,
  borderBottom: '1px solid #fecaca',
};
const body: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  padding: '8px 16px 16px',
};
const list: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const row = (highlight: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  border: '1px solid ' + (highlight ? '#4f46e5' : '#e5e7eb'),
  borderRadius: 6,
  background: highlight ? '#eef2ff' : '#fff',
});
const primaryBtn: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: '1px solid #4f46e5',
  borderRadius: 4,
  padding: '4px 12px',
  fontSize: 12,
  cursor: 'pointer',
};
const ghostBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  padding: '4px 12px',
  fontSize: 12,
  cursor: 'pointer',
};
const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: '#1e40af',
  cursor: 'pointer',
  fontSize: 12,
  textDecoration: 'underline',
};
const muted: React.CSSProperties = { color: '#6b7280', fontSize: 12, padding: 8 };
const confirmOverlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(15,23,42,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};
const confirmBox: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  padding: 16,
  width: 'min(400px, 100%)',
  boxShadow: '0 10px 30px rgba(15,23,42,0.25)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
