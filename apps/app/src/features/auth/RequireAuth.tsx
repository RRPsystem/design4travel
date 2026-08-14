import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../state/authStore.js';
import { LoginView } from './LoginView.js';

/**
 * Route-wrapper voor pagina's die auth vereisen.
 * - status='initializing' → spinner (wacht op Supabase session-check).
 * - status='signed-out'   → LoginView.
 * - status='signed-in'    → children.
 *
 * Note: Supabase's magic-link email-round-trip landet standaard op '/'.
 * De ?returnTo=<path> is een best-effort hint voor toekomstige uitbreiding;
 * MVP: gewoon redirect naar dashboard na login.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === 'initializing') {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f9fafb',
          color: '#6b7280',
        }}
      >
        Laden…
      </div>
    );
  }
  if (status === 'signed-out') {
    // Bewaar de intended-URL in query zodat we ná login desgewenst kunnen
    // terugkeren. LoginView zelf kijkt hier nog niet naar.
    const returnTo = location.pathname + location.search;
    if (returnTo === '/' || returnTo === '/login') {
      return <LoginView />;
    }
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <>{children}</>;
}

/**
 * Guard voor /login: als user al ingelogd is → naar dashboard.
 */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  if (status === 'signed-in') return <Navigate to="/projects" replace />;
  return <>{children}</>;
}
