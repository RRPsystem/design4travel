import type { DesignDoc } from '@design4/design-doc';
import type { SampleDataVariant } from '@design4/data-bindings';

/**
 * Typed postMessage protocol between host (chat app) and preview (iframe).
 * Same-origin in fase 1 — the origin split (and stricter CSP for Develop-mode
 * sandbox) comes later.
 */

export type HostToPreview =
  | { kind: 'load-doc'; doc: DesignDoc; variant: SampleDataVariant; selectedNodeId?: string }
  | { kind: 'set-selection'; nodeId?: string }
  | { kind: 'set-variant'; variant: SampleDataVariant };

export type PreviewToHost =
  | { kind: 'ready' }
  | { kind: 'node-selected'; nodeId: string; nodeType: string };

const CHANNEL_TAG = 'design4:v1';

export function sendToPreview(target: Window, message: HostToPreview): void {
  target.postMessage({ __d4: CHANNEL_TAG, ...message }, '*');
}

export function sendToHost(message: PreviewToHost): void {
  if (typeof window === 'undefined') return;
  window.parent.postMessage({ __d4: CHANNEL_TAG, ...message }, '*');
}

export function listenForPreview(handler: (msg: PreviewToHost) => void): () => void {
  const l = (e: MessageEvent) => {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.__d4 !== CHANNEL_TAG) return;
    const { __d4, ...rest } = e.data as Record<string, unknown> & { __d4: string };
    void __d4;
    handler(rest as PreviewToHost);
  };
  window.addEventListener('message', l);
  return () => window.removeEventListener('message', l);
}

export function listenForHost(handler: (msg: HostToPreview) => void): () => void {
  const l = (e: MessageEvent) => {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.__d4 !== CHANNEL_TAG) return;
    const { __d4, ...rest } = e.data as Record<string, unknown> & { __d4: string };
    void __d4;
    handler(rest as HostToPreview);
  };
  window.addEventListener('message', l);
  return () => window.removeEventListener('message', l);
}
