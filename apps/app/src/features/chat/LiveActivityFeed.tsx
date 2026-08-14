import { useEffect, useState } from 'react';
import { useChatStore, type LiveActivity } from '../../state/chatStore.js';

/**
 * Real-time weergave van een lopende AI-turn. Alles wat hier verschijnt komt
 * uit een echt event uit de Anthropic-stream (via onEvent in ClaudeAIAdapter).
 * Nooit fake — geen simulated typing, geen theatrical progress. Zie
 * project-no-fake-ux memory.
 */
export function LiveActivityFeed() {
  const live = useChatStore((s) => s.liveActivity);
  if (!live) return null;
  return <LiveBubble live={live} />;
}

function LiveBubble({ live }: { live: LiveActivity }) {
  const elapsedMs = useElapsed(live.startedAt);
  const elapsedLabel = formatElapsed(elapsedMs);

  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '92%',
        background: '#f3f4f6',
        color: '#111827',
        padding: '10px 14px',
        borderRadius: 12,
        fontSize: 14,
        lineHeight: 1.45,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        border: '1px solid #e5e7eb',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: '#6b7280',
        }}
      >
        <PulseDot />
        <span>{live.currentModel || 'denkt na'}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{elapsedLabel}</span>
      </div>

      {live.textSoFar ? (
        <div style={{ whiteSpace: 'pre-wrap' }}>
          {live.textSoFar}
          <span style={caretStyle} aria-hidden="true">
            ▍
          </span>
        </div>
      ) : null}

      {live.delegates.map((d, i) => (
        <div
          key={i}
          style={{
            fontSize: 11,
            color: '#6b7280',
            fontStyle: 'italic',
            borderLeft: '2px solid #d1d5db',
            paddingLeft: 8,
          }}
        >
          → delegate naar <strong>{d.to}</strong>: {d.rationale}
        </div>
      ))}

      {live.tools.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {live.tools.map((t) => (
            <div
              key={t.index}
              style={{
                fontSize: 12,
                color: t.completed ? '#111827' : '#6b7280',
                fontFamily:
                  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
              }}
            >
              <span style={{ opacity: 0.7, minWidth: 14 }}>
                {t.completed ? '✓' : '·'}
              </span>
              <span>
                <strong>{t.name}</strong>
                {t.summary ? <span style={{ color: '#374151' }}> {t.summary}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Puls-indicator — CSS-animation, geen fake — hij pulseert wanneer er ECHT
// een lopende AI-turn is (component is alleen gemount als liveActivity != null).
function PulseDot() {
  return (
    <>
      <span style={pulseDotStyle} aria-hidden="true" />
      <style>{PULSE_KEYFRAMES}</style>
    </>
  );
}

const pulseDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 4,
  background: '#4f46e5',
  animation: 'design4-pulse 1s ease-in-out infinite',
  display: 'inline-block',
};

const caretStyle: React.CSSProperties = {
  display: 'inline-block',
  marginLeft: 1,
  color: '#4f46e5',
  animation: 'design4-blink 1s step-end infinite',
};

const PULSE_KEYFRAMES = `
@keyframes design4-pulse {
  0%, 100% { opacity: 0.35; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.15); }
}
@keyframes design4-blink {
  0%, 50% { opacity: 1; }
  50.01%, 100% { opacity: 0; }
}
`;

/**
 * Re-render every 100ms zolang liveActivity actief is, zodat de elapsed-timer
 * mee-tikt. Real: Date.now() - startedAt is een echte gemeten wachttijd, geen
 * marketing-getal.
 */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, now - startedAt);
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}
