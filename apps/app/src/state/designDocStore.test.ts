import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignDoc, PersistenceAdapter } from '@design4/design-doc';
import {
  attachPersistence,
  attachVersions,
  attachVersionSink,
  detachPersistence,
  useDesignDocStore,
} from './designDocStore.js';
import { createMockVersionHistoryAdapter } from '../adapters/versions/mock.js';
import { LockVersionMismatchError } from '../adapters/persistence/supabase.js';
import { messageForRollbackError } from '../features/version-history/errorMessages.js';
import { seedLandingPage } from '../seed/mockLandingPage.js';

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
  useDesignDocStore.getState().reset(doc);
  // Simuleer de startversie-registratie zoals App.tsx hem doet.
  const s = versions.recordSnapshot(doc.id, doc);
  useDesignDocStore.setState({ currentLockVersion: s.version_number });
  return { doc, versions };
}

describe('designDocStore — version history integration', () => {
  beforeEach(() => {
    // Reset all module-level state.
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
    // Belangrijk: géén versionSink hangen zodat scheduleSave niet extra dingen doet.
    useDesignDocStore.getState().reset(seedLandingPage());

    // Trigger een save via applyOps (lege ops is voldoende — de store roept scheduleSave).
    useDesignDocStore.getState().applyOps([]);
    // De 300ms debounce afwachten.
    await new Promise((r) => setTimeout(r, 350));

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(useDesignDocStore.getState().saveState).toBe('lock-conflict');
    expect(useDesignDocStore.getState().lastError).toBe(
      messageForRollbackError('lock_version_mismatch'),
    );

    // Volgende applyOps mag de doc muteren maar mag GEEN nieuwe save triggeren.
    useDesignDocStore.getState().applyOps([]);
    await new Promise((r) => setTimeout(r, 350));
    expect(saveSpy).toHaveBeenCalledTimes(1); // niet nogmaals!
    // saveState is nog steeds lock-conflict.
    expect(useDesignDocStore.getState().saveState).toBe('lock-conflict');
  });

  it('applyOps ends preview-mode automatically (safety)', async () => {
    const { doc, versions } = await setup();
    const v1 = await versions.get(doc.id, 1);
    useDesignDocStore.getState().previewVersion(v1!);
    expect(useDesignDocStore.getState().previewingVersion).not.toBeNull();
    // Fake een no-op patch: geen echte mutatie nodig, alleen de trigger.
    // We roepen intern applyOps met een leeg array — dat produceert geen state-change
    // in de patch-implementatie, dus we simuleren met setState direct.
    // De actuele guarantee: elke echte mutatie ruimt preview op.
    // Voor deze test triggeren we het pad via een minimale valide patch.
    useDesignDocStore.getState().applyOps([]);
    // Bij een lege ops-array laat applyPatches het document ongewijzigd,
    // maar de store zet `previewingVersion` alsnog op null.
    expect(useDesignDocStore.getState().previewingVersion).toBeNull();
  });
});

describe('designDocStore — adapter-switch veiligheid', () => {
  beforeEach(() => {
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
    useDesignDocStore.getState().applyOps([]);
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
    useDesignDocStore.getState().applyOps([]);
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
    useDesignDocStore.getState().applyOps([]);
    await new Promise((r) => setTimeout(r, 350));
    expect(saveA).not.toHaveBeenCalled();
    expect(saveB).toHaveBeenCalledTimes(1);
  });
});
