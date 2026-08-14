import { useEffect, useRef } from 'react';
import { useChatStore } from '../../state/chatStore.js';
import { LiveActivityFeed } from './LiveActivityFeed.js';

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const liveActive = useChatStore((s) => s.liveActivity !== null);
  // Text-groei tijdens live streaming ook triggeren voor auto-scroll.
  const liveTextLen = useChatStore((s) => s.liveActivity?.textSoFar.length ?? 0);
  const liveToolCount = useChatStore((s) => s.liveActivity?.tools.length ?? 0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, liveActive, liveTextLen, liveToolCount]);

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {messages.map((m) => (
        <div
          key={m.id}
          style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
            background: m.role === 'user' ? '#4f46e5' : '#f3f4f6',
            color: m.role === 'user' ? '#fff' : '#111827',
            padding: '10px 14px',
            borderRadius: 12,
            whiteSpace: 'pre-wrap',
            fontSize: 14,
            lineHeight: 1.45,
          }}
        >
          {m.text}
        </div>
      ))}
      <LiveActivityFeed />
    </div>
  );
}
