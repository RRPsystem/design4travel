import { useEffect, useRef, useState } from 'react';
import { useDesignDocStore } from '../../state/designDocStore.js';
import { listenForPreview, sendToPreview } from './previewProtocol.js';

const VARIANTS = ['luxury', 'budget', 'missing-image'] as const;

export function PreviewPane() {
  const doc = useDesignDocStore((s) => s.doc);
  const variant = useDesignDocStore((s) => s.variant);
  const selectedNodeId = useDesignDocStore((s) => s.selectedNodeId);
  const select = useDesignDocStore((s) => s.select);
  const setVariant = useDesignDocStore((s) => s.setVariant);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');

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
    if (!win || !doc?.id) return;
    sendToPreview(win, { kind: 'load-doc', doc, variant, selectedNodeId });
  }, [ready, doc, variant, selectedNodeId]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#f9fafb' }}>
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
