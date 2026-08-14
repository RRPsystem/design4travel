import { create } from 'zustand';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
};

/**
 * Live-tool-item in de real-time AI-feed. Fill't zich op met echte events
 * uit de Anthropic-stream — nooit fake (zie project-no-fake-ux).
 */
export type LiveTool = {
  index: number;
  name: string;
  /** NL-samenvatting, aangevuld zodra tool_complete event binnenkomt. */
  summary?: string;
  completed: boolean;
};

/**
 * Snapshot van een lopende AI-turn. `null` als er geen AI-call actief is.
 * Wordt real-time bijgewerkt door onEvent-callbacks van de streaming adapter.
 */
export type LiveActivity = {
  /** ms-timestamp van start voor de elapsed-timer. */
  startedAt: number;
  /** Actief model — wisselt bij delegate-event. */
  currentModel: string;
  /** Text-delta's tot nu toe. */
  textSoFar: string;
  /** Tool_use-calls, oudste eerst; groeit met tool_start-events. */
  tools: LiveTool[];
  /** Delegate-transities. Meestal 0 of 1. */
  delegates: Array<{ from: string; to: string; rationale: string }>;
};

type State = {
  messages: ChatMessage[];
  busy: boolean;
  liveActivity: LiveActivity | null;
};

type Actions = {
  append(msg: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage;
  setBusy(v: boolean): void;
  clear(): void;
  /** Start een nieuwe live-turn. Reset previous state. */
  startLive(currentModel: string): void;
  /** Handle a streaming event door liveActivity bij te werken. */
  liveEvent(evt:
    | { kind: 'model_change'; model: string }
    | { kind: 'text_delta'; text: string }
    | { kind: 'tool_start'; index: number; tool: string }
    | { kind: 'tool_complete'; index: number; tool: string; summary: string }
    | { kind: 'delegate'; from: string; to: string; rationale: string }
  ): void;
  /** Sluit de live-turn af (zowel succes als error). */
  endLive(): void;
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
  liveActivity: null,
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
  startLive(currentModel) {
    set({
      liveActivity: {
        startedAt: Date.now(),
        currentModel,
        textSoFar: '',
        tools: [],
        delegates: [],
      },
    });
  },
  liveEvent(evt) {
    set((s) => {
      const live = s.liveActivity;
      if (!live) return s;
      switch (evt.kind) {
        case 'model_change':
          return { liveActivity: { ...live, currentModel: evt.model } };
        case 'text_delta':
          return { liveActivity: { ...live, textSoFar: live.textSoFar + evt.text } };
        case 'tool_start': {
          const tools = [
            ...live.tools,
            { index: evt.index, name: evt.tool, completed: false },
          ];
          return { liveActivity: { ...live, tools } };
        }
        case 'tool_complete': {
          const tools = live.tools.map((t) =>
            t.index === evt.index ? { ...t, completed: true, summary: evt.summary } : t,
          );
          // Als het tool_start event gemist was, alsnog aanmaken.
          if (!tools.some((t) => t.index === evt.index)) {
            tools.push({ index: evt.index, name: evt.tool, completed: true, summary: evt.summary });
          }
          return { liveActivity: { ...live, tools } };
        }
        case 'delegate':
          return {
            liveActivity: {
              ...live,
              delegates: [...live.delegates, { from: evt.from, to: evt.to, rationale: evt.rationale }],
            },
          };
      }
    });
  },
  endLive() {
    set({ liveActivity: null });
  },
}));
