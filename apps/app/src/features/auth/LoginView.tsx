import { useState } from 'react';
import { useAuthStore } from '../../state/authStore.js';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export function LoginView() {
  const sendMagicLink = useAuthStore((s) => s.sendMagicLink);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus('sending');
    setErrorMsg(null);
    const result = await sendMagicLink(email.trim());
    if (result.ok) {
      setStatus('sent');
    } else {
      setStatus('error');
      setErrorMsg(result.error);
    }
  };

  return (
    <div style={fullscreen}>
      <div style={card}>
        <div style={{ fontSize: 20, fontWeight: 600 }}>design4.travel</div>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          Log in met een magic-link. Je krijgt een e-mail met een klikbare inloglink.
        </div>

        {status === 'sent' ? (
          <div style={successBox}>
            Check je inbox op <strong>{email}</strong>. De link opent design4.travel opnieuw
            en logt je automatisch in.
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={label}>
              E-mailadres
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jij@voorbeeld.nl"
                style={input}
                disabled={status === 'sending'}
              />
            </label>
            <button type="submit" style={btnPrimary} disabled={status === 'sending' || !email.trim()}>
              {status === 'sending' ? 'Versturen…' : 'Stuur magic-link'}
            </button>
            {status === 'error' && errorMsg ? (
              <div style={errorBox}>{errorMsg}</div>
            ) : null}
          </form>
        )}
      </div>
    </div>
  );
}

const fullscreen: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  background: '#f9fafb',
  padding: 20,
};
const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 24,
  width: 'min(400px, 100%)',
  boxShadow: '0 8px 24px rgba(15,23,42,0.08)',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};
const label: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  color: '#374151',
  fontWeight: 500,
};
const input: React.CSSProperties = {
  border: '1px solid #d1d5db',
  borderRadius: 4,
  padding: '8px 10px',
  fontSize: 14,
  fontFamily: 'inherit',
};
const btnPrimary: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: '1px solid #4f46e5',
  borderRadius: 4,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
const successBox: React.CSSProperties = {
  background: '#ecfdf5',
  border: '1px solid #a7f3d0',
  color: '#065f46',
  borderRadius: 6,
  padding: 12,
  fontSize: 13,
  lineHeight: 1.5,
};
const errorBox: React.CSSProperties = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  color: '#991b1b',
  borderRadius: 6,
  padding: 10,
  fontSize: 12,
};
