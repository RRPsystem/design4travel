import { create } from 'zustand';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
};

type State = {
  messages: ChatMessage[];
  busy: boolean;
};

type Actions = {
  append(msg: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage;
  setBusy(v: boolean): void;
  clear(): void;
};

export const useChatStore = create<State & Actions>((set) => ({
  messages: [
    {
      id: 'welcome',
      role: 'assistant',
      text:
        'Welkom in design4.travel. Ik toon rechts een voorbeeld-landingspagina. Probeer bijvoorbeeld:\n' +
        '• "maak de titel groter"\n' +
        '• "verander de titel naar \'Ontdek Portugal\'"\n' +
        '• "wissel de twee secties om"\n' +
        '• "vervang de hero-afbeelding"\n' +
        '• "voeg een sectie toe met de titel \'Waarom bij ons boeken\'"\n' +
        '• "maak de call-to-action-knop paars"',
      createdAt: Date.now(),
    },
  ],
  busy: false,
  append(msg) {
    const full: ChatMessage = { ...msg, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() };
    set((s) => ({ messages: [...s.messages, full] }));
    return full;
  },
  setBusy(v) {
    set({ busy: v });
  },
  clear() {
    set({ messages: [] });
  },
}));
