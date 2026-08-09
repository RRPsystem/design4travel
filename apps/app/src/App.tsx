import { useEffect } from 'react';
import { ChatPane } from './features/chat/ChatPane.js';
import { PreviewPane } from './features/preview/PreviewPane.js';
import { attachPersistence, useDesignDocStore } from './state/designDocStore.js';
import { localStoragePersistence } from './adapters/persistence/localStorage.js';
import { seedLandingPage } from './seed/mockLandingPage.js';

export function App() {
  const reset = useDesignDocStore((s) => s.reset);
  const doc = useDesignDocStore((s) => s.doc);

  useEffect(() => {
    attachPersistence(localStoragePersistence);
    (async () => {
      const seed = seedLandingPage();
      const stored = await localStoragePersistence.load(seed.id);
      reset(stored ?? seed);
    })();
  }, [reset]);

  if (!doc?.id) {
    return (
      <div style={fullscreen}>
        <div style={{ color: '#6b7280' }}>Laden…</div>
      </div>
    );
  }

  return (
    <div style={fullscreen}>
      <ChatPane />
      <PreviewPane />
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
