import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './state/authStore.js';
import { LoginView } from './features/auth/LoginView.js';
import { RedirectIfSignedIn, RequireAuth } from './features/auth/RequireAuth.js';
import { DashboardView } from './features/workspace/DashboardView.js';
import { ProjectView } from './features/workspace/ProjectView.js';
import { EditorView } from './features/editor/EditorView.js';

/**
 * Root-app. React-Router-gedreven, geen implicit-bootstrap-flow meer.
 *
 * Routes:
 *   /                                        → Home. Signed-in redirect naar
 *                                              /projects; signed-out toont
 *                                              login.
 *   /login                                   → LoginView (magic-link).
 *                                              Signed-in redirect naar
 *                                              /projects (via RedirectIfSignedIn).
 *   /projects                                → Dashboard (project-lijst).
 *   /projects/:projectId                     → Project-view (doc-lijst).
 *   /projects/:projectId/documents/:docId    → Editor (chat + preview).
 *   *                                        → 404 fallback → dashboard.
 *
 * SPA-fallback voor directe URLs is via `netlify.toml`
 * (/* → /index.html status=200) — refresh op /projects/:id/documents/:id
 * werkt correct.
 */
export function App() {
  const initSession = useAuthStore((s) => s.initSession);

  useEffect(() => {
    initSession();
  }, [initSession]);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <RedirectIfSignedIn>
              <LoginView />
            </RedirectIfSignedIn>
          }
        />
        <Route
          path="/login"
          element={
            <RedirectIfSignedIn>
              <LoginView />
            </RedirectIfSignedIn>
          }
        />
        <Route
          path="/projects"
          element={
            <RequireAuth>
              <DashboardView />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId"
          element={
            <RequireAuth>
              <ProjectView />
            </RequireAuth>
          }
        />
        <Route
          path="/projects/:projectId/documents/:documentId"
          element={
            <RequireAuth>
              <EditorView />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
