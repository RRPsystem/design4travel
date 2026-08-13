import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../adapters/supabase/client.js';

type AuthStatus = 'initializing' | 'signed-out' | 'signed-in';

type State = {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
};

type Actions = {
  initSession(): Promise<void>;
  sendMagicLink(email: string): Promise<{ ok: true } | { ok: false; error: string }>;
  signOut(): Promise<void>;
};

export const useAuthStore = create<State & Actions>((set) => ({
  status: 'initializing',
  session: null,
  user: null,

  async initSession() {
    const { data } = await supabase.auth.getSession();
    set({
      session: data.session,
      user: data.session?.user ?? null,
      status: data.session ? 'signed-in' : 'signed-out',
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      set({
        session,
        user: session?.user ?? null,
        status: session ? 'signed-in' : 'signed-out',
      });
    });
  },

  async sendMagicLink(email) {
    const emailRedirectTo =
      typeof window !== 'undefined' ? window.location.origin : undefined;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  async signOut() {
    await supabase.auth.signOut();
  },
}));
