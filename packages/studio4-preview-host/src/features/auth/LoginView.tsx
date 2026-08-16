import { useState } from 'react';
import { Mail } from 'lucide-react';
import { supabase } from '../../lib/supabase';

/**
 * Magic-link login-form voor de preview-host. Zelfde patroon als apps/app.
 * Na "Verstuur link": e-mail met deeplink terug naar deze site; Supabase
 * detecteert het access_token in de URL en start de sessie.
 *
 * VOORWAARDE (jouw kant, eenmalig):
 * In Supabase → Authentication → URL Configuration → Additional Redirect URLs
 * toevoegen: https://previewdesign4.netlify.app en http://localhost:5174
 */

export function LoginView() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes('@')) return;
    setStatus('sending');
    setErrorMsg(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) {
      setStatus('error');
      setErrorMsg(error.message);
    } else {
      setStatus('sent');
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-6">
      <div className="max-w-md w-full">
        <div className="mb-8 text-center">
          <div className="text-xs uppercase tracking-widest text-gray-500 mb-2">
            Design4 · Studio4 Preview Host
          </div>
          <h1 className="text-2xl font-bold">Log in met magic-link</h1>
          <p className="mt-2 text-sm text-gray-400">
            Preview-host vereist een geverifieerde sessie om sandboxes te starten.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-xs uppercase tracking-widest text-gray-500 mb-1">
              E-mailadres
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jij@voorbeeld.nl"
              className="w-full rounded bg-gray-900 border border-gray-800 px-3 py-2 text-gray-100 focus:border-white/60 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={status === 'sending' || !email.includes('@')}
            className="w-full inline-flex items-center justify-center gap-2 rounded bg-white text-gray-900 px-4 py-2 font-semibold disabled:opacity-50"
          >
            <Mail className="h-4 w-4" />
            {status === 'sending' ? 'Verzenden…' : 'Verstuur magic-link'}
          </button>
        </form>

        {status === 'sent' && (
          <div className="mt-4 rounded bg-green-950 border border-green-800 px-3 py-2 text-sm text-green-200">
            Link verstuurd naar <strong>{email}</strong>. Check je inbox en klik de link — je komt hier terug.
          </div>
        )}
        {status === 'error' && errorMsg && (
          <div className="mt-4 rounded bg-red-950 border border-red-800 px-3 py-2 text-sm text-red-200">
            {errorMsg}
          </div>
        )}
      </div>
    </div>
  );
}
