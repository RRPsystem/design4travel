import { useEffect, useRef, useState } from 'react';
import { useDesignDocStore } from '../../state/designDocStore.js';
import { listenForPreview, sendToPreview } from './previewProtocol.js';

const VARIANTS = ['luxury', 'budget', 'missing-image'] as const;

interface Props {
  onRequestRestorePreviewed(): void;
}

export function PreviewPane({ onRequestRestorePreviewed }: Props) {
  const doc = useDesignDocStore((s) => s.doc);
  const previewingVersion = useDesignDocStore((s) => s.previewingVersion);
  const stopPreviewingVersion = useDesignDocStore((s) => s.stopPreviewingVersion);
  const variant = useDesignDocStore((s) => s.variant);
  const selectedNodeId = useDesignDocStore((s) => s.selectedNodeId);
  const select = useDesignDocStore((s) => s.select);
  const setVariant = useDesignDocStore((s) => s.setVariant);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');

  // Welk document toont de preview? Actuele doc, tenzij de gebruiker een
  // oudere versie bekijkt.
  const previewDoc = previewingVersion?.doc ?? doc;

  // Listen for preview→host messages
  useEffect(() => {
    return listenForPreview((msg) => {
      if (msg.kind === 'ready') setReady(true);
      if (msg.kind === 'node-selected') select(msg.nodeId);
    });
  }, [select]);

  // Push doc whenever it changes (once preview is ready)
  useEffect(() => {
    if (!ready) return;
    const win = iframeRef.current?.contentWindow;
    if (!win || !previewDoc?.id) return;
    sendToPreview(win, { kind: 'load-doc', doc: previewDoc, variant, selectedNodeId });
  }, [ready, previewDoc, variant, selectedNodeId]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#f9fafb' }}>
      {previewingVersion ? (
        <div
          style={{
            padding: '8px 12px',
            background: '#eff6ff',
            borderBottom: '1px solid #bfdbfe',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 12,
            color: '#1e3a8a',
          }}
          role="status"
        >
          <span>
            Je bekijkt <strong>versie {previewingVersion.version_number}</strong>. De editor
            is ongewijzigd.
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button type="button" onClick={stopPreviewingVersion} style={ghostBtn}>
              Terug naar actueel
            </button>
            <button type="button" onClick={onRequestRestorePreviewed} style={primaryBtn}>
              Deze versie herstellen
            </button>
          </div>
        </div>
      ) : null}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          background: '#fff',
        }}
      >
        <div style={{ fontSize: 12, color: '#6b7280' }}>Voorbeeld</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['desktop', 'mobile'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setViewport(v)}
              style={pillBtn(viewport === v)}
            >
              {v === 'desktop' ? 'Desktop' : 'Mobiel'}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>Sample-data:</span>
          {VARIANTS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVariant(v)}
              style={pillBtn(variant === v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 16,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
        }}
      >
        <iframe
          ref={iframeRef}
          src="/preview.html"
          title="design4 preview"
          style={{
            width: viewport === 'desktop' ? '100%' : 390,
            maxWidth: viewport === 'desktop' ? 1200 : 390,
            height: '100%',
            minHeight: 800,
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#fff',
          }}
        />
      </div>
    </div>
  );
}

function pillBtn(active: boolean) {
  return {
    background: active ? '#4f46e5' : 'transparent',
    color: active ? '#fff' : '#374151',
    border: '1px solid ' + (active ? '#4f46e5' : '#d1d5db'),
    borderRadius: 999,
    padding: '3px 10px',
    fontSize: 11,
    cursor: 'pointer',
  } as const;
}

const primaryBtn: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: '1px solid #4f46e5',
  borderRadius: 4,
  padding: '3px 10px',
  fontSize: 11,
  cursor: 'pointer',
};
const ghostBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#1e40af',
  border: '1px solid #bfdbfe',
  borderRadius: 4,
  padding: '3px 10px',
  fontSize: 11,
  cursor: 'pointer',
};
