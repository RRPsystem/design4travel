import { useEffect, useState } from 'react';
import { SCHEMA_VERSION, type VersionHistoryAdapter } from '@design4/design-doc';
import { ChatPane } from './features/chat/ChatPane.js';
import { PreviewPane } from './features/preview/PreviewPane.js';
import { VersionHistoryPanel } from './features/version-history/VersionHistoryPanel.js';
import { messageForRollbackError } from './features/version-history/errorMessages.js';
import { LoginView } from './features/auth/LoginView.js';
import {
  attachPersistence,
  attachVersions,
  useDesignDocStore,
} from './state/designDocStore.js';
import { useAuthStore } from './state/authStore.js';
import { supabase } from './adapters/supabase/client.js';
import { createSupabasePersistenceAdapter } from './adapters/persistence/supabase.js';
import {
  bootstrapDocument,
  type BootstrapResult,
} from './adapters/persistence/bootstrap.js';
import { createSupabaseVersionHistoryAdapter } from './adapters/versions/supabase.js';
import { ClaudeAIAdapter } from './adapters/ai/claudeAI.js';
import { attachAI } from './adapters/ai/registry.js';
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
  const [bootstrapError, setBootstrapError] = useState<BootstrapResult | null>(null);
  const [versionsAdapter, setVersionsAdapter] = useState<VersionHistoryAdapter | null>(
    null,
  );

  // Bootstrap loopt exact één keer per signed-in-mount:
  //   1. bootstrap → project_id, project_document_id, doc, lock_version
  //   2. reset store + seed lock_version
  //   3. attach Supabase-adapters (autosave-gate: attachPersistence is de laatste
  //      stap zodat scheduleSave nooit fires vóórdat lock_version bekend is)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const seed = seedLandingPage();
      const result = await bootstrapDocument({ client: supabase, seedDoc: seed });
      if (cancelled) return;
      if (!result.ok) {
        setBootstrapError(result);
        return;
      }
      reset(result.doc);
      useDesignDocStore.setState({ currentLockVersion: result.lockVersion });

      const versions = createSupabaseVersionHistoryAdapter({
        client: supabase,
        onLockVersionUpdate: (n) =>
          useDesignDocStore.setState({ currentLockVersion: n }),
      });
      const persistence = createSupabasePersistenceAdapter({
        client: supabase,
        projectId: result.projectId,
        schemaVersion: SCHEMA_VERSION,
        getExpectedLockVersion: () =>
          useDesignDocStore.getState().currentLockVersion,
        onLockVersionUpdate: (n) =>
          useDesignDocStore.setState({ currentLockVersion: n }),
      });

      attachVersions(versions);
      // Attach AI-adapter voordat de user prompts kan sturen (chat is direct
      // beschikbaar zodra AuthedApp rendert). Zonder attach zou getAI() de
      // MockAIAdapter teruggeven en zou de chat lokaal-pattern-matchen i.p.v.
      // via de Edge Function te lopen.
      attachAI(
        new ClaudeAIAdapter({
          client: supabase,
          projectDocumentId: result.projectDocumentId,
        }),
      );
      // Autosave-gate: attach ALS ALLERLAATSTE — pas nu mogen mutaties fires.
      attachPersistence(persistence);
      setVersionsAdapter(versions);
    })();
    return () => {
      cancelled = true;
    };
  }, [reset]);

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

  if (bootstrapError) {
    return <BootstrapErrorView result={bootstrapError} onSignOut={signOut} />;
  }

  if (!doc?.id || !versionsAdapter) {
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

function BootstrapErrorView({
  result,
  onSignOut,
}: {
  result: BootstrapResult;
  onSignOut: () => void;
}) {
  if (result.ok) return null;
  let title = 'Kon werkruimte niet laden';
  let body = '';
  if (result.reason === 'auth_required') {
    title = 'Sessie verlopen';
    body = 'Je bent uitgelogd. Log opnieuw in om verder te werken.';
  } else if (result.reason === 'no_active_organization') {
    title = 'Geen actieve werkruimte';
    body =
      'Er is geen actieve werkruimte aan je account gekoppeld. Neem contact op met de beheerder.';
  } else if (result.reason === 'multiple_active_organizations') {
    title = 'Meerdere werkruimtes';
    const names = (result.organizations ?? []).map((o) => o.name).join(', ');
    body = `Je bent lid van meerdere werkruimtes (${names}). Werkruimte-keuze is nog niet ondersteund in deze versie.`;
  } else {
    body = `Er ging iets mis bij het initialiseren. Probeer het later opnieuw. (${result.detail ?? 'geen details'})`;
  }
  return (
    <div style={fullscreen}>
      <div style={bootstrapErrorBox}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
        <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{body}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onSignOut} style={btnGhost}>
            Uitloggen
          </button>
        </div>
      </div>
    </div>
  );
}

const bootstrapErrorBox: React.CSSProperties = {
  margin: 'auto',
  background: '#fff',
  borderRadius: 8,
  padding: 24,
  width: 'min(480px, 92vw)',
  boxShadow: '0 12px 32px rgba(15,23,42,0.15)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

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
