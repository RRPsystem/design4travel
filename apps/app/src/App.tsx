import { useEffect, useMemo, useState } from 'react';
import { ChatPane } from './features/chat/ChatPane.js';
import { PreviewPane } from './features/preview/PreviewPane.js';
import { VersionHistoryPanel } from './features/version-history/VersionHistoryPanel.js';
import { messageForRollbackError } from './features/version-history/errorMessages.js';
import { LoginView } from './features/auth/LoginView.js';
import {
  attachPersistence,
  attachVersions,
  attachVersionSink,
  useDesignDocStore,
} from './state/designDocStore.js';
import { useAuthStore } from './state/authStore.js';
import { localStoragePersistence } from './adapters/persistence/localStorage.js';
import { createMockVersionHistoryAdapter } from './adapters/versions/mock.js';
import { seedLandingPage } from './seed/mockLandingPage.js';

export function App() {
  const status = useAuthStore((s) => s.status);
  const initSession = useAuthStore((s) => s.initSession);

  useEffect(() => {
    initSession();
  }, [initSession]);

  if (status === 'initializing') {
    return (
      <div style={fullscreen}>
        <div style={{ color: '#6b7280' }}>Laden…</div>
      </div>
    );
  }
  if (status === 'signed-out') {
    return <LoginView />;
  }
  return <AuthedApp />;
}

function AuthedApp() {
  const reset = useDesignDocStore((s) => s.reset);
  const doc = useDesignDocStore((s) => s.doc);
  const previewingVersion = useDesignDocStore((s) => s.previewingVersion);
  const restoreVersion = useDesignDocStore((s) => s.restoreVersion);
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewRestoreError, setPreviewRestoreError] = useState<string | null>(null);
  const [previewRestoreConfirm, setPreviewRestoreConfirm] = useState(false);

  // Één versions-adapter voor de hele app-levensduur.
  const versionsAdapter = useMemo(() => createMockVersionHistoryAdapter(), []);

  useEffect(() => {
    attachPersistence(localStoragePersistence);
    attachVersions(versionsAdapter);
    attachVersionSink((doc) => versionsAdapter.recordSnapshot(doc.id, doc));
    (async () => {
      const seed = seedLandingPage();
      const stored = await localStoragePersistence.load(seed.id);
      const initial = stored ?? seed;
      reset(initial);
      // Leg de startversie vast zodat er meteen historie is (versie 1).
      const summary = versionsAdapter.recordSnapshot(initial.id, initial);
      useDesignDocStore.setState({ currentLockVersion: summary.version_number });
    })();
  }, [reset, versionsAdapter]);

  const handleRequestRestorePreviewed = () => {
    setPreviewRestoreError(null);
    setPreviewRestoreConfirm(true);
  };

  const handleConfirmRestorePreviewed = async () => {
    if (!previewingVersion) return;
    const result = await restoreVersion(previewingVersion);
    if (!result.ok) {
      setPreviewRestoreError(messageForRollbackError(result.error));
    }
    setPreviewRestoreConfirm(false);
  };

  if (!doc?.id) {
    return (
      <div style={fullscreen}>
        <div style={{ color: '#6b7280' }}>Laden…</div>
      </div>
    );
  }

  return (
    <div style={fullscreen}>
      <ChatPane onOpenVersionHistory={() => setHistoryOpen(true)} />
      <PreviewPane onRequestRestorePreviewed={handleRequestRestorePreviewed} />
      <VersionHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        adapter={versionsAdapter}
        projectDocumentId={doc.id}
      />
      <div style={userStrip}>
        <span style={{ color: '#6b7280' }}>{user?.email}</span>
        <button type="button" onClick={() => signOut()} style={btnGhost}>
          Uitloggen
        </button>
      </div>
      {previewRestoreConfirm && previewingVersion ? (
        <div style={confirmBackdrop} role="dialog" aria-modal="true">
          <div style={confirmBox}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              Versie {previewingVersion.version_number} herstellen?
            </div>
            <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>
              De huidige toestand wordt automatisch bewaard als nieuwe versie.
              Deze rollback is later ook weer ongedaan te maken door terug te keren
              naar die bewaarde versie.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setPreviewRestoreConfirm(false)}
                style={btnGhost}
              >
                Annuleren
              </button>
              <button
                type="button"
                onClick={handleConfirmRestorePreviewed}
                style={btnPrimary}
              >
                Herstel deze versie
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {previewRestoreError ? (
        <div style={toast} role="alert" onClick={() => setPreviewRestoreError(null)}>
          {previewRestoreError}
          <span style={{ marginLeft: 12, opacity: 0.7 }}>(klik om te sluiten)</span>
        </div>
      ) : null}
    </div>
  );
}

const fullscreen: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  background: '#f9fafb',
};
const confirmBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 60,
};
const confirmBox: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  padding: 20,
  width: 'min(420px, 90vw)',
  boxShadow: '0 12px 32px rgba(15,23,42,0.25)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const btnPrimary: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: '1px solid #4f46e5',
  borderRadius: 4,
  padding: '6px 14px',
  fontSize: 13,
  cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
};
const userStrip: React.CSSProperties = {
  position: 'fixed',
  bottom: 12,
  left: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '4px 10px',
  background: 'rgba(255,255,255,0.9)',
  border: '1px solid #e5e7eb',
  borderRadius: 20,
  fontSize: 11,
  boxShadow: '0 2px 8px rgba(15,23,42,0.08)',
  zIndex: 40,
};
const toast: React.CSSProperties = {
  position: 'fixed',
  bottom: 24,
  right: 24,
  padding: '10px 14px',
  background: '#fef2f2',
  border: '1px solid #fecaca',
  color: '#991b1b',
  borderRadius: 6,
  fontSize: 12,
  boxShadow: '0 8px 24px rgba(15,23,42,0.15)',
  zIndex: 70,
  cursor: 'pointer',
  maxWidth: 400,
};
