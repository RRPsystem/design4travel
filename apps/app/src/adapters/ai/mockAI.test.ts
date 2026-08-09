import { describe, expect, it } from 'vitest';
import { seedLandingPage } from '../../seed/mockLandingPage.js';
import { MockAIAdapter } from './mockAI.js';

const ai = new MockAIAdapter();

describe('MockAIAdapter — six required prompt patterns', () => {
  it('1. "maak de titel groter"', async () => {
    const r = await ai.generatePatch({ doc: seedLandingPage() }, 'maak de titel groter');
    expect(r.patches.length).toBeGreaterThan(0);
    expect(r.patches[0]).toMatchObject({ kind: 'setProp', key: 'titleFontSize' });
  });

  it('2. "verander de titel naar ..."', async () => {
    const r = await ai.generatePatch(
      { doc: seedLandingPage() },
      "verander de titel naar 'Ontdek Portugal'",
    );
    expect(r.patches[0]).toMatchObject({ kind: 'setProp', key: 'title', value: 'Ontdek Portugal' });
  });

  it('3. "wissel de twee secties om"', async () => {
    const r = await ai.generatePatch({ doc: seedLandingPage() }, 'wissel de twee secties om');
    expect(r.patches[0]?.kind).toBe('reorderChildren');
  });

  it('4. "vervang de hero-afbeelding"', async () => {
    const r = await ai.generatePatch({ doc: seedLandingPage() }, 'vervang de hero-afbeelding');
    expect(r.patches[0]).toMatchObject({ kind: 'setProp', key: 'imageSrc' });
  });

  it('5. "voeg een sectie toe met de titel ..."', async () => {
    const r = await ai.generatePatch(
      { doc: seedLandingPage() },
      "voeg een sectie toe met de titel 'Waarom bij ons boeken'",
    );
    expect(r.patches[0]?.kind).toBe('insertNode');
  });

  it('6. "maak de call-to-action-knop paars"', async () => {
    const r = await ai.generatePatch(
      { doc: seedLandingPage() },
      'maak de call-to-action-knop paars',
    );
    expect(r.patches.some((p) => p.kind === 'setProp' && p.key === 'color')).toBe(true);
  });

  it('unknown prompt returns a hint message with zero patches', async () => {
    const r = await ai.generatePatch({ doc: seedLandingPage() }, 'schilder een olifant');
    expect(r.patches).toHaveLength(0);
    expect(r.assistantMessage.length).toBeGreaterThan(10);
  });
});
