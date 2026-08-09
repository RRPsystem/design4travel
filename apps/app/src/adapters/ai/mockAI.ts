import type { DesignDoc, NodeInstance } from '@design4/design-doc';
import type { AIAdapter, AIContext, AIResponse } from './types.js';

/**
 * Deterministic mock AI — pattern-matches prompts and emits typed patches.
 * No network, no key, no LLM. Replace with a real ClaudeAIAdapter (proxied
 * via backend) when we start wiring the real API.
 */
export class MockAIAdapter implements AIAdapter {
  readonly name = 'mock';

  async generatePatch(context: AIContext, prompt: string): Promise<AIResponse> {
    const p = prompt.trim();

    for (const handler of handlers) {
      const result = handler(p, context);
      if (result) return result;
    }

    return {
      assistantMessage:
        "Ik weet nog niet hoe ik dat moet doen. Probeer bijvoorbeeld: \n" +
        '• "maak de titel groter"\n' +
        '• "verander de titel naar \'Ontdek Portugal\'"\n' +
        '• "wissel de twee secties om"\n' +
        '• "vervang de hero-afbeelding"\n' +
        '• "voeg een sectie toe met de titel \'Waarom bij ons boeken\'"\n' +
        '• "maak de call-to-action-knop paars"',
      patches: [],
    };
  }
}

type Handler = (prompt: string, ctx: AIContext) => AIResponse | null;

const handlers: Handler[] = [
  handleMakeTitleBigger,
  handleChangeTitle,
  handleSwapSections,
  handleReplaceHeroImage,
  handleAddSection,
  handleColorCta,
];

// --- 1. Titel groter ---
function handleMakeTitleBigger(prompt: string, ctx: AIContext): AIResponse | null {
  const re = /\bmaak\b.*\btitel\b.*\b(groter|kleiner)\b/i;
  const m = re.exec(prompt);
  if (!m) return null;
  const bigger = m[1]!.toLowerCase() === 'groter';
  const delta = bigger ? 10 : -10;

  const hero = findFirstNodeOfType(ctx.doc, 'hero');
  if (hero) {
    const current = (hero.props.titleFontSize as number | undefined) ?? 56;
    const next = Math.max(16, Math.min(200, current + delta));
    return {
      assistantMessage: `Hero-titel op ${next}px gezet.`,
      patches: [{ kind: 'setProp', nodeId: hero.id, key: 'titleFontSize', value: next }],
    };
  }
  const heading = findFirstNodeOfType(ctx.doc, 'heading');
  if (heading) {
    const current = (heading.props.fontSize as number | undefined) ?? 32;
    const next = Math.max(12, Math.min(200, current + delta));
    return {
      assistantMessage: `Titel op ${next}px gezet.`,
      patches: [{ kind: 'setProp', nodeId: heading.id, key: 'fontSize', value: next }],
    };
  }
  return {
    assistantMessage: 'Ik kon geen titel vinden in dit ontwerp.',
    patches: [],
  };
}

// --- 2. Titel wijzigen ---
function handleChangeTitle(prompt: string, ctx: AIContext): AIResponse | null {
  const re = /\bverander\b.*\btitel\b.*\bnaar\b\s*['"]?([^'"]+?)['"]?\s*$/i;
  const m = re.exec(prompt);
  if (!m) return null;
  const newTitle = m[1]!.trim();

  const hero = findFirstNodeOfType(ctx.doc, 'hero');
  if (hero) {
    return {
      assistantMessage: `Hero-titel gewijzigd naar "${newTitle}".`,
      patches: [{ kind: 'setProp', nodeId: hero.id, key: 'title', value: newTitle }],
    };
  }
  const heading = findFirstNodeOfType(ctx.doc, 'heading');
  if (heading) {
    return {
      assistantMessage: `Titel gewijzigd naar "${newTitle}".`,
      patches: [{ kind: 'setProp', nodeId: heading.id, key: 'text', value: newTitle }],
    };
  }
  return { assistantMessage: 'Geen titel gevonden om te wijzigen.', patches: [] };
}

// --- 3. Secties omwisselen ---
function handleSwapSections(prompt: string, ctx: AIContext): AIResponse | null {
  const re = /\b(wissel|draai)\b.*\bsecties?\b.*\b(om|van plek)\b/i;
  if (!re.test(prompt)) return null;

  // Find the container whose direct children are the swappable sections.
  const root = ctx.doc.pages[0]?.root;
  if (!root?.children || root.children.length < 2) {
    return { assistantMessage: 'Er zijn minder dan twee secties om te wisselen.', patches: [] };
  }
  const sections = root.children.filter(
    (c) => c.id.startsWith('section-') || c.type === 'layout-column',
  );
  if (sections.length < 2) {
    return { assistantMessage: 'Ik kon geen twee inhoudssecties vinden.', patches: [] };
  }
  const [first, second] = sections;
  // Compute new order on root.children: swap first and second occurrences.
  const order = root.children.map((c) => c.id);
  const idxA = order.indexOf(first!.id);
  const idxB = order.indexOf(second!.id);
  [order[idxA], order[idxB]] = [order[idxB]!, order[idxA]!];
  return {
    assistantMessage: 'Twee secties omgewisseld.',
    patches: [{ kind: 'reorderChildren', parentId: root.id, order }],
  };
}

// --- 4. Hero-afbeelding vervangen ---
const REPLACEMENT_IMAGES = [
  'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1600',
  'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?w=1600',
  'https://images.unsplash.com/photo-1519677100203-a0e668c92439?w=1600',
  'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=1600',
];

function handleReplaceHeroImage(prompt: string, ctx: AIContext): AIResponse | null {
  const re = /\bvervang\b.*\bhero.?afbeelding\b/i;
  if (!re.test(prompt)) return null;

  const hero = findFirstNodeOfType(ctx.doc, 'hero');
  if (!hero) return { assistantMessage: 'Geen hero-blok gevonden.', patches: [] };

  const current = hero.props.imageSrc as string | undefined;
  const candidates = REPLACEMENT_IMAGES.filter((u) => u !== current);
  const next = candidates[Math.floor(Math.random() * candidates.length)]!;
  return {
    assistantMessage: 'Hero-afbeelding vervangen.',
    patches: [{ kind: 'setProp', nodeId: hero.id, key: 'imageSrc', value: next }],
  };
}

// --- 5. Sectie toevoegen ---
function handleAddSection(prompt: string, ctx: AIContext): AIResponse | null {
  const re = /\bvoeg\b.*\bsectie\b.*\btitel\b\s*['"]?([^'"]+?)['"]?\s*$/i;
  const m = re.exec(prompt);
  if (!m) return null;
  const title = m[1]!.trim();
  const root = ctx.doc.pages[0]?.root;
  if (!root) return { assistantMessage: 'Geen root-container gevonden.', patches: [] };
  const id = `section-${cryptoRandom()}`;
  const newSection: NodeInstance = {
    id,
    type: 'layout-column',
    props: { gap: 12, padding: 32, align: 'start' },
    children: [
      { id: `${id}-title`, type: 'heading', props: { text: title, level: 2 } },
      {
        id: `${id}-text`,
        type: 'text',
        props: { text: 'Beschrijf hier waarom deze sectie belangrijk is.' },
      },
    ],
  };
  const insertIndex = Math.max(0, (root.children?.length ?? 1) - 1); // just before CTA if present
  return {
    assistantMessage: `Sectie "${title}" toegevoegd.`,
    patches: [{ kind: 'insertNode', parentId: root.id, index: insertIndex, node: newSection }],
  };
}

// --- 6. CTA-kleur ---
const COLOR_MAP: Record<string, string> = {
  paars: '#7c3aed',
  blauw: '#2563eb',
  rood: '#dc2626',
  groen: '#16a34a',
  zwart: '#111827',
  wit: '#ffffff',
  oranje: '#f97316',
  geel: '#eab308',
  roze: '#ec4899',
};

function handleColorCta(prompt: string, ctx: AIContext): AIResponse | null {
  const re = /\bmaak\b.*\b(call.?to.?action|cta|knop)\b\s+(\w+)/i;
  const m = re.exec(prompt);
  if (!m) return null;
  const color = COLOR_MAP[m[2]!.toLowerCase()];
  if (!color) return { assistantMessage: `Kleur "${m[2]}" ken ik nog niet.`, patches: [] };

  const cta = findFirstNodeOfType(ctx.doc, 'cta');
  if (!cta) return { assistantMessage: 'Geen CTA-knop gevonden.', patches: [] };
  return {
    assistantMessage: `CTA-knop op ${m[2]!.toLowerCase()} gezet.`,
    patches: [
      { kind: 'setProp', nodeId: cta.id, key: 'color', value: color },
      { kind: 'setProp', nodeId: cta.id, key: 'textColor', value: '#ffffff' },
    ],
  };
}

// --- helpers ---

function findFirstNodeOfType(doc: DesignDoc, type: string): NodeInstance | undefined {
  for (const page of doc.pages) {
    const found = walk(page.root, (n) => n.type === type);
    if (found) return found;
  }
  return undefined;
}

function walk(
  node: NodeInstance,
  pred: (n: NodeInstance) => boolean,
): NodeInstance | undefined {
  if (pred(node)) return node;
  if (!node.children) return undefined;
  for (const c of node.children) {
    const r = walk(c, pred);
    if (r) return r;
  }
  return undefined;
}

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}
