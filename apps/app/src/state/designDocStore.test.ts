import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignDoc, PatchOp, PersistenceAdapter } from '@design4/design-doc';
import { createDefaultRegistry } from '@design4/typed-nodes';
import {
  attachNodeRegistry,
  attachPersistence,
  attachVersions,
  attachVersionSink,
  detachNodeRegistry,
  detachPersistence,
  useDesignDocStore,
} from './designDocStore.js';
import { createMockVersionHistoryAdapter } from '../adapters/versions/mock.js';
import { LockVersionMismatchError } from '../adapters/persistence/supabase.js';
import { messageForRollbackError } from '../features/version-history/errorMessages.js';
import { seedLandingPage } from '../seed/mockLandingPage.js';

/**
 * Genereert een echte inhoudelijke mutatie op de section-a-title heading.
 * Sinds applyOps no-ops niet meer als save-trigger accepteert, hebben tests
 * die scheduleSave willen triggeren een unieke waarde per aanroep nodig.
 */
let __mutationCounter = 0;
function realMutation(): PatchOp[] {
  __mutationCounter += 1;
  return [
    {
      kind: 'setProp',
      nodeId: 'section-a-title',
      key: 'text',
      value: `mutation-${__mutationCounter}`,
    },
  ];
}

function noopPersistence() {
  return {
    async load(): Promise<DesignDoc | null> {
      return null;
    },
    async save(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

async function setup() {
  const doc = seedLandingPage();
  const versions = createMockVersionHistoryAdapter();
  attachPersistence(noopPersistence());
  attachVersions(versions);
  attachVersionSink((d) => versions.recordSnapshot(d.id, d));
  // NodeRegistry — matcht productieopstelling in workspaceStore.openDocument,
  // zodat property-key-validatie in applyOps daadwerkelijk actief is.
  attachNodeRegistry(createDefaultRegistry());
  useDesignDocStore.getState().reset(doc);
  // Simuleer de startversie-registratie zoals App.tsx hem doet.
  const s = versions.recordSnapshot(doc.id, doc);
  useDesignDocStore.setState({ currentLockVersion: s.version_number });
  return { doc, versions };
}

describe('designDocStore — version history integration', () => {
  beforeEach(() => {
    // Reset all module-level state.
    detachNodeRegistry();
    useDesignDocStore.getState().reset(seedLandingPage());
  });

  it('previewVersion sets previewingVersion; editor doc unchanged', async () => {
    const { doc, versions } = await setup();
    // Maak een tweede versie met andere titel.
    const v2Doc: DesignDoc = { ...doc, project: { ...doc.project, title: 'Tweede' } };
    versions.recordSnapshot(doc.id, v2Doc);
    useDesignDocStore.setState({ doc: v2Doc, currentLockVersion: 2 });

    const snapshot = await versions.get(doc.id, 1);
    expect(snapshot).not.toBeNull();
    useDesignDocStore.getState().previewVersion(snapshot!);

    // previewingVersion is de oude versie, doc blijft de nieuwe.
    expect(useDesignDocStore.getState().previewingVersion?.version_number).toBe(1);
    expect(useDesignDocStore.getState().doc.project.title).toBe('Tweede');
  });

  it('stopPreviewingVersion clears the preview', async () => {
    const { doc, versions } = await setup();
    const s = await versions.get(doc.id, 1);
    useDesignDocStore.getState().previewVersion(s!);
    expect(useDesignDocStore.getState().previewingVersion).not.toBeNull();
    useDesignDocStore.getState().stopPreviewingVersion();
    expect(useDesignDocStore.getState().previewingVersion).toBeNull();
  });

  it('restoreVersion happy path — doc + lock_version updated, preview cleared', async () => {
    const { doc, versions } = await setup();
    // Editor is nu op versie 1. Maak versie 2 met andere titel.
    const v2Doc: DesignDoc = { ...doc, project: { ...doc.project, title: 'Tweede' } };
    versions.recordSnapshot(doc.id, v2Doc);
    useDesignDocStore.setState({ doc: v2Doc, currentLockVersion: 2 });

    // User bekijkt versie 1.
    const v1 = await versions.get(doc.id, 1);
    useDesignDocStore.getState().previewVersion(v1!);

    // Herstel.
    const result = await useDesignDocStore.getState().restoreVersion(v1!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nieuwe versie is versie 3.
    expect(result.new_version_number).toBe(3);
    expect(result.new_lock_version).toBe(3);
    // Doc is nu weer de eerste titel.
    expect(useDesignDocStore.getState().doc.project.title).toBe(doc.project.title);
    expect(useDesignDocStore.getState().currentLockVersion).toBe(3);
    expect(useDesignDocStore.getState().previewingVersion).toBeNull();
    // Historie behouden: v2 (Tweede) staat er nog.
    const v2Fresh = await versions.get(doc.id, 2);
    expect(v2Fresh?.doc.project.title).toBe('Tweede');
  });

  it('restoreVersion fail — lock_version_mismatch propagates without mutating doc', async () => {
    const { doc, versions } = await setup();
    versions.recordSnapshot(doc.id, { ...doc, project: { ...doc.project, title: 'X' } });
    useDesignDocStore.setState({ doc: { ...doc, project: { ...doc.project, title: 'X' } }, currentLockVersion: 2 });
    // Forceer een stale lock.
    useDesignDocStore.setState({ currentLockVersion: 999 });
    const v1 = await versions.get(doc.id, 1);
    const result = await useDesignDocStore.getState().restoreVersion(v1!);
    expect(result).toEqual({ ok: false, error: 'lock_version_mismatch' });
    expect(useDesignDocStore.getState().doc.project.title).toBe('X');
    expect(useDesignDocStore.getState().isRestoring).toBe(false);
  });

  it('restoreVersion fail — simulated insufficient_role does not mutate doc', async () => {
    const { doc, versions } = await setup();
    versions.simulateNextRollbackError('insufficient_role');
    const v1 = await versions.get(doc.id, 1);
    const result = await useDesignDocStore.getState().restoreVersion(v1!);
    expect(result).toEqual({ ok: false, error: 'insufficient_role' });
    // Doc is not mutated.
    expect(useDesignDocStore.getState().doc.project.title).toBe(doc.project.title);
  });

  it('save that throws LockVersionMismatchError → saveState=lock-conflict, subsequent saves are paused', async () => {
    // Custom persistence die bij de eerste save een LockVersionMismatchError throwt,
    // daarna een spy houdt bij hoe vaak save wordt aangeroepen.
    const saveSpy = vi.fn(async () => {
      throw new LockVersionMismatchError();
    });
    const persistence: PersistenceAdapter = {
      async load() { return null; },
      save: saveSpy,
      async delete() {},
    };
    attachPersistence(persistence);
    attachVersions(createMockVersionHistoryAdapter());
    attachNodeRegistry(createDefaultRegistry());
    // Belangrijk: géén versionSink hangen zodat scheduleSave niet extra dingen doet.
    useDesignDocStore.getState().reset(seedLandingPage());

    // Trigger een save via een echte mutatie — sinds no-op-detectie mag
    // een lege ops-array geen scheduleSave meer veroorzaken.
    useDesignDocStore.getState().applyOps(realMutation());
    // De 300ms debounce afwachten.
    await new Promise((r) => setTimeout(r, 350));

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(useDesignDocStore.getState().saveState).toBe('lock-conflict');
    expect(useDesignDocStore.getState().lastError).toBe(
      messageForRollbackError('lock_version_mismatch'),
    );

    // Volgende mutatie mag de doc muteren maar mag GEEN nieuwe save triggeren.
    useDesignDocStore.getState().applyOps(realMutation());
    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).toHaveBeenCalledTimes(1); // niet nogmaals!
    // saveState is nog steeds lock-conflict.
    expect(useDesignDocStore.getState().saveState).toBe('lock-conflict');
  });

  it('een echte mutatie beëindigt preview-mode automatisch (safety)', async () => {
    const { doc, versions } = await setup();
    const v1 = await versions.get(doc.id, 1);
    useDesignDocStore.getState().previewVersion(v1!);
    expect(useDesignDocStore.getState().previewingVersion).not.toBeNull();
    // Guarantee: elke inhoudelijke mutatie ruimt preview op.
    const result = useDesignDocStore.getState().applyOps(realMutation());
    expect(result).toEqual({ ok: true, changed: true });
    expect(useDesignDocStore.getState().previewingVersion).toBeNull();
  });

  it('een no-op laat preview-mode ongemoeid (was niks aan veranderd)', async () => {
    const { doc, versions } = await setup();
    const v1 = await versions.get(doc.id, 1);
    useDesignDocStore.getState().previewVersion(v1!);
    // Dezelfde titel opnieuw instellen — no-op.
    const currentTitle = useDesignDocStore.getState().doc.pages[0]!.root.children![1]!
      .children![0]!.props.text;
    const result = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'section-a-title', key: 'text', value: currentTitle },
    ]);
    expect(result).toEqual({ ok: true, changed: false, reason: 'no-op' });
    // Preview blijft staan — er is niks gewijzigd, dus geen reden om te sluiten.
    expect(useDesignDocStore.getState().previewingVersion).not.toBeNull();
  });
});

describe('designDocStore — adapter-switch veiligheid', () => {
  beforeEach(() => {
    // Reset globale state + registry (adapter-switch-tests wisselen persistence
    // maar hangen wel altijd een registry — anders faalt applyOps fail-closed).
    detachNodeRegistry();
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());
  });

  it('detachPersistence stopt de pending save-timer — geen save meer', async () => {
    const saveSpy = vi.fn(async () => {});
    const adapter: PersistenceAdapter = {
      async load() { return null; },
      save: saveSpy,
      async delete() {},
    };
    attachPersistence(adapter);
    useDesignDocStore.getState().reset(seedLandingPage());
    useDesignDocStore.getState().applyOps(realMutation());
    // Meteen detach vóór de 300ms debounce afloopt.
    detachPersistence();
    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('rapid switch: pending save van adapter A fires NIET op adapter B', async () => {
    // Adapter A: langzame save (200ms).
    const saveA = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const adapterA: PersistenceAdapter = {
      async load() { return null; },
      save: saveA,
      async delete() {},
    };
    // Adapter B: instant save.
    const saveB = vi.fn(async () => {});
    const adapterB: PersistenceAdapter = {
      async load() { return null; },
      save: saveB,
      async delete() {},
    };
    // Wire A + schedule save.
    attachPersistence(adapterA);
    useDesignDocStore.getState().reset(seedLandingPage());
    useDesignDocStore.getState().applyOps(realMutation());
    // Wacht tot de debounce afloopt en de save-A start (async).
    await new Promise((r) => setTimeout(r, 320));
    // Switch naar B midden in de save-A callback.
    attachPersistence(adapterB);
    // Wacht op save-A's fake latency + iets extra.
    await new Promise((r) => setTimeout(r, 250));
    // Save-A moet zijn aangeroepen (de setTimeout was al gevuurd), maar
    // saveState mag NIET op 'saved' zijn gezet want adapter is inmiddels B.
    // En saveB mag NIET zijn aangeroepen door deze pending call.
    expect(saveB).not.toHaveBeenCalled();
    // saveA is aangeroepen (was al in-flight), maar het resultaat wordt
    // genegeerd door de post-await captured-check.
    expect(saveA).toHaveBeenCalledTimes(1);
  });

  it('applyOps na attach van adapter B triggert alleen save op B (niet A)', async () => {
    const saveA = vi.fn(async () => {});
    const adapterA: PersistenceAdapter = {
      async load() { return null; },
      save: saveA,
      async delete() {},
    };
    const saveB = vi.fn(async () => {});
    const adapterB: PersistenceAdapter = {
      async load() { return null; },
      save: saveB,
      async delete() {},
    };
    attachPersistence(adapterA);
    // Direct switch naar B vóór eerste applyOps.
    attachPersistence(adapterB);
    useDesignDocStore.getState().reset(seedLandingPage());
    useDesignDocStore.getState().applyOps(realMutation());
    await new Promise((r) => setTimeout(r, 350));
    expect(saveA).not.toHaveBeenCalled();
    expect(saveB).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// applyOps — ApplyResult contract + no-op/validatie/atomiciteit
// -----------------------------------------------------------------------------

describe('designDocStore.applyOps — succesbepaling op basis van werkelijke doc', () => {
  beforeEach(() => {
    // Reset globale attaches tussen tests om cross-contaminatie te voorkomen.
    detachNodeRegistry();
    useDesignDocStore.getState().reset(seedLandingPage());
  });

  it('dezelfde titel opnieuw instellen → no-op, geen save, geen versie', async () => {
    const saveSpy = vi.fn(async () => {});
    const versions = createMockVersionHistoryAdapter();
    const versionSpy = vi.spyOn(versions, 'recordSnapshot');
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachVersions(versions);
    attachVersionSink((d) => versions.recordSnapshot(d.id, d));
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    const currentTitle = useDesignDocStore.getState().doc.project.title;
    // De project.title zit niet in een node-prop, dus doen we het op de hero-title:
    const currentHeroTitle = useDesignDocStore
      .getState()
      .doc.pages[0]!.root.children![0]!.props.title;

    const result = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'hero', key: 'title', value: currentHeroTitle },
    ]);
    expect(result).toEqual({ ok: true, changed: false, reason: 'no-op' });

    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).not.toHaveBeenCalled();
    expect(versionSpy).not.toHaveBeenCalled();
    // Doc onveranderd (behalve dat er niets veranderd is — check project.title).
    expect(useDesignDocStore.getState().doc.project.title).toBe(currentTitle);
  });

  it('align=center instellen terwijl deze al center is → no-op', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    // Hero heeft in seed al align: 'center'.
    expect(useDesignDocStore.getState().doc.pages[0]!.root.children![0]!.props.align).toBe(
      'center',
    );

    const result = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'hero', key: 'align', value: 'center' },
    ]);
    expect(result).toEqual({ ok: true, changed: false, reason: 'no-op' });

    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('geldige titelwijziging → changed:true, save wordt getriggerd', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    const result = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'hero', key: 'title', value: 'Nieuwe titel' },
    ]);
    expect(result).toEqual({ ok: true, changed: true });
    expect(useDesignDocStore.getState().doc.pages[0]!.root.children![0]!.props.title).toBe(
      'Nieuwe titel',
    );

    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('niet-ondersteunde hero-property → afgewezen vóór apply, geen save', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());
    const before = useDesignDocStore.getState().doc;

    const result = useDesignDocStore.getState().applyOps([
      // `background` bestaat niet in HeroPropsSchema.
      { kind: 'setProp', nodeId: 'hero', key: 'background', value: '#000' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported-property');
    expect(result.message).toMatch(/background/);

    // Doc onveranderd.
    expect(useDesignDocStore.getState().doc).toBe(before);
    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('patch naar onbekende node → afgewezen, geen save', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());
    const before = useDesignDocStore.getState().doc;

    const result = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'niet-bestaand', key: 'title', value: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-node');

    expect(useDesignDocStore.getState().doc).toBe(before);
    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('meerdere patches waarvan één ongeldig → alles atomair afgewezen', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());
    const before = useDesignDocStore.getState().doc;
    const heroTitleBefore = before.pages[0]!.root.children![0]!.props.title;

    const result = useDesignDocStore.getState().applyOps([
      // 1. Geldig
      { kind: 'setProp', nodeId: 'hero', key: 'title', value: 'Nieuwe titel' },
      // 2. Ongeldig — onbekende hero-property
      { kind: 'setProp', nodeId: 'hero', key: 'background', value: '#000' },
      // 3. Geldig
      { kind: 'setProp', nodeId: 'hero', key: 'subtitle', value: 'Nieuwe subtitel' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported-property');

    // GEEN van de patches mag zijn toegepast — atomair.
    expect(useDesignDocStore.getState().doc.pages[0]!.root.children![0]!.props.title).toBe(
      heroTitleBefore,
    );
    expect(useDesignDocStore.getState().doc.pages[0]!.root.children![0]!.props.subtitle).toBe(
      before.pages[0]!.root.children![0]!.props.subtitle,
    );

    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Meerstaps-patches met sequentiële prevalidatie
  // ---------------------------------------------------------------------------

  it('addPage gevolgd door insertNode in de nieuwe page-root → succes', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    const result = useDesignDocStore.getState().applyOps([
      {
        kind: 'addPage',
        page: {
          id: 'page-2',
          name: 'Golfreis',
          root: { id: 'page-2-root', type: 'layout-column', props: {} },
        },
      },
      {
        // Insert in de root van de NIEUWE page — bestaat niet in state.doc,
        // wel in de tussentijdse candidate. Sequentiële prevalidatie moet
        // dit accepteren.
        kind: 'insertNode',
        parentId: 'page-2-root',
        index: 0,
        node: { id: 'p2-heading', type: 'heading', props: { text: 'Welkom', level: 2 } },
      },
    ]);
    expect(result).toEqual({ ok: true, changed: true });
    const state = useDesignDocStore.getState();
    expect(state.doc.pages).toHaveLength(2);
    expect(state.doc.pages[1]!.root.children).toHaveLength(1);
    expect(state.doc.pages[1]!.root.children![0]!.id).toBe('p2-heading');

    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('insertNode gevolgd door setProp op die nieuwe node → succes', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    const result = useDesignDocStore.getState().applyOps([
      {
        kind: 'insertNode',
        parentId: 'root',
        index: 0,
        node: { id: 'new-heading', type: 'heading', props: { text: 'Oorspronkelijk', level: 2 } },
      },
      {
        // setProp op node die pas na de vorige op bestaat.
        kind: 'setProp',
        nodeId: 'new-heading',
        key: 'text',
        value: 'Aangepast',
      },
    ]);
    expect(result).toEqual({ ok: true, changed: true });
    const inserted = useDesignDocStore.getState().doc.pages[0]!.root.children![0]!;
    expect(inserted.id).toBe('new-heading');
    expect(inserted.props.text).toBe('Aangepast');

    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('geldige eerste structurele patch + ongeldige tweede → niets opgeslagen', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());
    const before = useDesignDocStore.getState().doc;
    const beforePageCount = before.pages.length;
    const beforeBrandTokens = before.brandTokens;

    const result = useDesignDocStore.getState().applyOps([
      // 1. Geldige structurele patch — een brandToken.
      { kind: 'setBrandToken', key: 'brand.secondary', value: '#123456' },
      // 2. Ongeldig — insertNode met onbekend node-type.
      {
        kind: 'insertNode',
        parentId: 'root',
        index: 0,
        node: { id: 'x', type: 'niet-bestaand-type', props: {} },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported-property');

    // GEEN van de patches mag zijn toegepast — atomair.
    const after = useDesignDocStore.getState().doc;
    expect(after).toBe(before);
    expect(after.pages).toHaveLength(beforePageCount);
    expect(after.brandTokens).toEqual(beforeBrandTokens);

    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('meerdere geldige patches op dezelfde node → correcte eindtoestand', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    const result = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'hero', key: 'title', value: 'Titel A' },
      { kind: 'setProp', nodeId: 'hero', key: 'subtitle', value: 'Subtitel B' },
      { kind: 'setProp', nodeId: 'hero', key: 'align', value: 'left' },
      { kind: 'setProp', nodeId: 'hero', key: 'title', value: 'Titel C' }, // overschrijft eerdere
    ]);
    expect(result).toEqual({ ok: true, changed: true });
    const hero = useDesignDocStore.getState().doc.pages[0]!.root.children![0]!;
    expect(hero.props.title).toBe('Titel C');
    expect(hero.props.subtitle).toBe('Subtitel B');
    expect(hero.props.align).toBe('left');

    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Legacy-property tolerantie op bestaande nodes
  // ---------------------------------------------------------------------------

  it('bestaande legacy-property op hero blokkeert geldige title-wijziging niet, nieuwe onbekende blijft afgewezen', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());

    // Custom seed: hero heeft naast bekende props een legacy onbekende
    // `deprecatedShadow`-key die al lang meelift uit een vorig schema-versie.
    const legacySeed = seedLandingPage();
    const hero = legacySeed.pages[0]!.root.children![0]!;
    hero.props = { ...hero.props, deprecatedShadow: '0 4px 8px rgba(0,0,0,0.3)' };
    useDesignDocStore.getState().reset(legacySeed);

    // Geldige title-wijziging op de hero met legacy prop → moet SLAGEN.
    const okResult = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'hero', key: 'title', value: 'Nieuwe hero-titel' },
    ]);
    expect(okResult).toEqual({ ok: true, changed: true });
    const heroAfter = useDesignDocStore.getState().doc.pages[0]!.root.children![0]!;
    expect(heroAfter.props.title).toBe('Nieuwe hero-titel');
    // Legacy-prop staat er nog — bewust niet gestript.
    expect(heroAfter.props.deprecatedShadow).toBe('0 4px 8px rgba(0,0,0,0.3)');

    // Nieuwe onbekende prop op dezelfde hero → moet nog steeds AFGEWEZEN
    // worden, ook al leeft er al een legacy-key op de node.
    const failResult = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'hero', key: 'newBogusKey', value: 42 },
    ]);
    expect(failResult.ok).toBe(false);
    if (failResult.ok) return;
    expect(failResult.reason).toBe('unsupported-property');
    expect(failResult.message).toMatch(/newBogusKey/);

    await new Promise((r) => setTimeout(r, 350));
    // Alleen de eerste (geldige) call heeft een save getriggerd.
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Registry fail-closed
  // ---------------------------------------------------------------------------

  it('zonder NodeRegistry → applyOps faalt met registry-missing, geen save', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    // BEWUST géén attachNodeRegistry — beforeEach heeft `detachNodeRegistry`.
    useDesignDocStore.getState().reset(seedLandingPage());
    const before = useDesignDocStore.getState().doc;

    const result = useDesignDocStore.getState().applyOps([
      { kind: 'setProp', nodeId: 'hero', key: 'title', value: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('registry-missing');

    // Doc onveranderd.
    expect(useDesignDocStore.getState().doc).toBe(before);
    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// PR-2 (live-preview): streaming-transactie-API
// -----------------------------------------------------------------------------

describe('designDocStore — streaming-transactie (live-preview)', () => {
  beforeEach(() => {
    detachNodeRegistry();
    useDesignDocStore.getState().reset(seedLandingPage());
  });

  it('happy path: begin → 2 applyStreamOps → commit produceert 1 undo-eenheid + 1 save', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    const before = useDesignDocStore.getState().doc;
    const stackDepthBefore = useDesignDocStore.getState().stack.past.length;

    useDesignDocStore.getState().beginStream();
    const r1 = useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'section-a-title', key: 'text', value: 'Live-1',
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.changed).toBe(true);

    // Doc is DIRECT gemuteerd — preview zou het al zien.
    expect(useDesignDocStore.getState().doc).not.toBe(before);
    // Maar geen undo-entry en geen save-scheduling.
    expect(useDesignDocStore.getState().stack.past.length).toBe(stackDepthBefore);
    await new Promise((r) => setTimeout(r, 50));
    expect(saveSpy).not.toHaveBeenCalled();

    const r2 = useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'section-b-title', key: 'text', value: 'Live-2',
    });
    expect(r2.ok).toBe(true);

    // Commit — nu wél één undo-entry en één save.
    const commit = useDesignDocStore.getState().commitStream();
    expect(commit.changed).toBe(true);
    expect(useDesignDocStore.getState().stack.past.length).toBe(stackDepthBefore + 1);

    await new Promise((r) => setTimeout(r, 400));
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('undo na streaming turn brengt hele turn terug in één klik', async () => {
    attachPersistence(noopPersistence());
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());
    const originalText = 'Reizen op maat';

    useDesignDocStore.getState().beginStream();
    useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'section-a-title', key: 'text', value: 'Tussenstap',
    });
    useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'section-a-title', key: 'text', value: 'Eindresultaat',
    });
    useDesignDocStore.getState().commitStream();

    // Verifieer eind-state.
    const findNode = (doc: DesignDoc, id: string) => {
      const stack = [doc.pages[0]!.root];
      while (stack.length) {
        const n = stack.pop()!;
        if (n.id === id) return n;
        if (n.children) stack.push(...n.children);
      }
      return null;
    };
    expect(findNode(useDesignDocStore.getState().doc, 'section-a-title')!.props.text).toBe('Eindresultaat');

    // Één undo → terug naar de originele tekst (niet naar 'Tussenstap'!).
    const undone = useDesignDocStore.getState().undo();
    expect(undone).toBe(true);
    expect(findNode(useDesignDocStore.getState().doc, 'section-a-title')!.props.text).toBe(originalText);
  });

  it('rollback herstelt naar baseline, geen undo-entry, geen save', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    const before = useDesignDocStore.getState().doc;
    const stackDepthBefore = useDesignDocStore.getState().stack.past.length;

    useDesignDocStore.getState().beginStream();
    useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'section-a-title', key: 'text', value: 'Half-applied',
    });
    // Doc IS gemuteerd.
    expect(useDesignDocStore.getState().doc).not.toBe(before);

    useDesignDocStore.getState().rollbackStream();
    // Doc terug naar baseline.
    expect(useDesignDocStore.getState().doc).toBe(before);
    // Geen undo-entry aangemaakt.
    expect(useDesignDocStore.getState().stack.past.length).toBe(stackDepthBefore);
    // Geen save.
    await new Promise((r) => setTimeout(r, 400));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('commit zonder mutaties → geen undo-entry, geen save', async () => {
    const saveSpy = vi.fn(async () => {});
    attachPersistence({ async load() { return null; }, save: saveSpy, async delete() {} });
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());
    const stackDepthBefore = useDesignDocStore.getState().stack.past.length;

    useDesignDocStore.getState().beginStream();
    const commit = useDesignDocStore.getState().commitStream();
    expect(commit.changed).toBe(false);
    expect(useDesignDocStore.getState().stack.past.length).toBe(stackDepthBefore);
    await new Promise((r) => setTimeout(r, 400));
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('ongeldige stream-op faalt individueel, latere ops kunnen wél door', async () => {
    attachPersistence(noopPersistence());
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    useDesignDocStore.getState().beginStream();
    // Bad op: nodeId bestaat niet.
    const bad = useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'ghost-node', key: 'text', value: 'X',
    });
    expect(bad.ok).toBe(false);
    // Goede op erna: moet werken.
    const good = useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'section-a-title', key: 'text', value: 'Werkt-toch',
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.changed).toBe(true);
    useDesignDocStore.getState().commitStream();
  });

  it('applyStreamOp zonder voorafgaande beginStream = no-op (fail-safe)', async () => {
    attachPersistence(noopPersistence());
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());
    const before = useDesignDocStore.getState().doc;

    const res = useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'section-a-title', key: 'text', value: 'Stray',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(false);
    // Doc onveranderd.
    expect(useDesignDocStore.getState().doc).toBe(before);
  });

  it('reset() mid-stream gooit baseline weg (cross-doc safety)', async () => {
    attachPersistence(noopPersistence());
    attachNodeRegistry(createDefaultRegistry());
    useDesignDocStore.getState().reset(seedLandingPage());

    useDesignDocStore.getState().beginStream();
    useDesignDocStore.getState().applyStreamOp({
      kind: 'setProp', nodeId: 'section-a-title', key: 'text', value: 'Mid-stream',
    });
    // Reset naar een nieuw doc — baseline mag NIET terugkomen via rollbackStream.
    const newDoc: DesignDoc = { ...seedLandingPage(), id: 'nieuw-doc' };
    useDesignDocStore.getState().reset(newDoc);
    // Rollback moet no-op zijn (baseline hoort bij oude doc, is opgeruimd).
    useDesignDocStore.getState().rollbackStream();
    expect(useDesignDocStore.getState().doc.id).toBe('nieuw-doc');
  });
});
