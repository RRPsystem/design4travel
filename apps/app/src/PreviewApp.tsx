import { useEffect, useState } from 'react';
import type { DesignDoc } from '@design4/design-doc';
import { renderTarget } from '@design4/renderer';
import { createDefaultRegistry } from '@design4/typed-nodes';
import { SAMPLE_DATA_VARIANTS, type SampleDataVariant } from '@design4/data-bindings';
import { listenForHost, sendToHost } from './features/preview/previewProtocol.js';

const registry = createDefaultRegistry();

export function PreviewApp() {
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [variant, setVariant] = useState<SampleDataVariant>('luxury');
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [currentPageId, setCurrentPageId] = useState<string | undefined>(undefined);

  useEffect(() => {
    sendToHost({ kind: 'ready' });
    return listenForHost((msg) => {
      if (msg.kind === 'load-doc') {
        setDoc(msg.doc);
        setVariant(msg.variant);
        setSelectedNodeId(msg.selectedNodeId);
        if (msg.currentPageId) setCurrentPageId(msg.currentPageId);
      } else if (msg.kind === 'set-selection') {
        setSelectedNodeId(msg.nodeId);
      } else if (msg.kind === 'set-variant') {
        setVariant(msg.variant);
      } else if (msg.kind === 'set-page') {
        setCurrentPageId(msg.pageId);
      }
    });
  }, []);

  if (!doc) {
    return (
      <div style={{ padding: 48, color: '#6b7280', fontFamily: 'system-ui' }}>
        Wachten op ontwerp…
      </div>
    );
  }

  // Kies de te tonen pagina. Renderer's web-target rendert pages[0], dus we
  // sturen een sub-doc waar de gekozen pagina op index 0 staat. Alle andere
  // eigenschappen (brandTokens, project, etc.) blijven ongewijzigd.
  const pageToShow =
    doc.pages.find((p) => p.id === currentPageId) ?? doc.pages[0] ?? null;
  if (!pageToShow) {
    return (
      <div style={{ padding: 48, color: '#6b7280', fontFamily: 'system-ui' }}>
        Dit ontwerp heeft nog geen pagina&apos;s.
      </div>
    );
  }
  const previewDoc: DesignDoc = { ...doc, pages: [pageToShow] };

  try {
    return (
      <div
        onClick={() => sendSelect(undefined)}
        style={{ minHeight: '100vh' }}
      >
        {renderTarget('web', previewDoc, {
          registry,
          dataModel: SAMPLE_DATA_VARIANTS[variant],
          selectedNodeId,
          onSelect: ({ nodeId, nodeType }) => sendSelect(nodeId, nodeType),
        })}
      </div>
    );
  } catch (e) {
    return (
      <div
        style={{
          padding: 32,
          color: '#991b1b',
          background: '#fee2e2',
          fontFamily: 'system-ui',
        }}
      >
        Renderfout: {String(e)}
      </div>
    );
  }
}

function sendSelect(nodeId?: string, nodeType?: string) {
  if (nodeId) {
    sendToHost({ kind: 'node-selected', nodeId, nodeType: nodeType ?? '' });
  }
}
