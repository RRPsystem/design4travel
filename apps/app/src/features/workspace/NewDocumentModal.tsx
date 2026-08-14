import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../../state/workspaceStore.js';

const DOCUMENT_TYPES = [
  { value: 'website', label: 'Website' },
  { value: 'offerte', label: 'Offerte' },
  { value: 'roadbook', label: 'Roadbook' },
  { value: 'brochure', label: 'Brochure' },
  { value: 'social', label: 'Social' },
  { value: 'document', label: 'Document' },
] as const;

interface Props {
  projectId: string;
  onClose(): void;
}

/**
 * Nieuw document toevoegen aan een BESTAAND project. Wraps de
 * `create-document` Edge Function via useWorkspaceStore. Nieuwe doc krijgt
 * eigen document_type dat MAG afwijken van projects.document_type.
 */
export function NewDocumentModal({ projectId, onClose }: Props) {
  const navigate = useNavigate();
  const createDocumentInProject = useWorkspaceStore((s) => s.createDocumentInProject);

  const [title, setTitle] = useState('');
  const [documentType, setDocumentType] = useState<string>('website');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const res = await createDocumentInProject({
      project_id: projectId,
      document_type: documentType,
      title: title.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(mapError(res.error));
      return;
    }
    onClose();
    navigate(`/projects/${projectId}/documents/${res.data.project_document_id}`);
  }

  return (
    <div style={backdrop} role="dialog" aria-modal="true">
      <div style={panel}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Nieuw document</h2>
        <p style={{ margin: '4px 0 12px', color: '#6b7280', fontSize: 12 }}>
          Voeg een nieuw document toe aan dit project. Type mag afwijken van
          bestaande documenten binnen dit project.
        </p>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={label}>
            Titel
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="bv. Offerte 2027"
              maxLength={200}
              required
              autoFocus
              style={input}
            />
          </label>
          <label style={label}>
            Type
            <select
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              style={{ ...input, appearance: 'auto' }}
            >
              {DOCUMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>
          {error ? (
            <div style={{ background: '#fee2e2', color: '#991b1b', padding: 8, borderRadius: 4, fontSize: 12 }}>
              {error}
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" onClick={onClose} style={btnGhost} disabled={busy}>
              Annuleren
            </button>
            <button type="submit" style={btnPrimary} disabled={!canSubmit}>
              {busy ? 'Bezig…' : 'Aanmaken'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function mapError(code: string): string {
  switch (code) {
    case 'project_not_active':
      return 'Het project is gearchiveerd of niet meer actief.';
    case 'insufficient_role':
      return 'Je hebt niet de juiste rol om documenten aan te maken.';
    case 'membership_not_active':
      return 'Je bent geen actief lid meer van deze werkruimte.';
    default:
      return `Er ging iets mis: ${code}`;
  }
}

const backdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};
const panel: React.CSSProperties = {
  background: '#fff',
  borderRadius: 10,
  padding: 20,
  width: 'min(420px, 92vw)',
  boxShadow: '0 24px 48px rgba(15,23,42,0.35)',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const label: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#374151',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const input: React.CSSProperties = {
  border: '1px solid #d1d5db',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 14,
  fontFamily: 'inherit',
};
const btnPrimary: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: '1px solid #4f46e5',
  borderRadius: 4,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  padding: '8px 12px',
  fontSize: 13,
  cursor: 'pointer',
};
