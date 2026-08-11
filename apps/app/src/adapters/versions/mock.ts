import type {
  DesignDoc,
  RollbackResult,
  VersionHistoryAdapter,
  VersionSnapshot,
  VersionSummary,
  RollbackErrorCode,
} from '@design4/design-doc';

/**
 * In-memory implementatie van {@link VersionHistoryAdapter} voor de mock-app.
 * Bootst de invarianten van migration 0010 na:
 * - versies zijn immutable, worden alleen aangemaakt (nooit gewijzigd/verwijderd);
 * - rollback maakt een NIEUWE versie met de teruggezette inhoud;
 * - optimistic-lock via `lock_version` — mismatch geeft `lock_version_mismatch`;
 * - schema-versie moet gelijk zijn aan de huidige — anders
 *   `target_schema_version_incompatible`.
 *
 * De client-facing rollback-flow van A3.2 controleert de body vóór de RPC;
 * hier accepteren we alleen valide inputs (getallen ≥ 0/1) en beschouwen we
 * niet-bestaande documenten of versies als de bijbehorende foutcode.
 */
type DocState = {
  /** Huidige lock_version (0-based, bumped bij elke nieuwe versie). */
  lockVersion: number;
  /** schema_version van de huidige inhoud — alleen rollback naar gelijke schema mag. */
  schemaVersion: string;
  /** Historie in oplopende volgorde (oudste eerst). Nooit muteren/verwijderen. */
  versions: VersionSnapshot[];
};

export interface MockVersionHistoryAdapterOptions {
  /**
   * Vertraging in ms per call, om async UX (loaders, foutbanners) realistisch
   * te kunnen testen. Default 0 (synchroon-achtig via microtask).
   */
  latencyMs?: number;
}

export interface MockVersionHistoryAdapter extends VersionHistoryAdapter {
  /** Legt een nieuwe versie vast (aangeroepen door de store na een mutatie). */
  recordSnapshot(
    projectDocumentId: string,
    doc: DesignDoc,
    meta?: { author_id?: string; author_label?: string; author_note?: string },
  ): VersionSummary;
  /** Handig voor tests + demo: forceer één specifieke foutcode op de volgende rollback. */
  simulateNextRollbackError(code: RollbackErrorCode | null): void;
  /** Huidige lock_version — nodig voor de rollback-aanroep vanuit de store. */
  getCurrentLockVersion(projectDocumentId: string): number;
  /** Test-only: reset alle in-memory state. */
  __reset(): void;
}

export function createMockVersionHistoryAdapter(
  opts: MockVersionHistoryAdapterOptions = {},
): MockVersionHistoryAdapter {
  const store = new Map<string, DocState>();
  const latency = opts.latencyMs ?? 0;
  let simulatedError: RollbackErrorCode | null = null;

  const wait = () =>
    latency > 0 ? new Promise<void>((r) => setTimeout(r, latency)) : Promise.resolve();

  function ensure(projectDocumentId: string, schemaVersion?: string): DocState {
    let state = store.get(projectDocumentId);
    if (!state) {
      state = {
        lockVersion: 0,
        schemaVersion: schemaVersion ?? '1',
        versions: [],
      };
      store.set(projectDocumentId, state);
    }
    return state;
  }

  return {
    recordSnapshot(projectDocumentId, doc, meta) {
      const state = ensure(projectDocumentId, doc.version);
      // Houd schema_version in sync met de laatst opgeslagen versie.
      state.schemaVersion = doc.version;
      const versionNumber = state.versions.length + 1;
      const snapshot: VersionSnapshot = {
        version_number: versionNumber,
        created_at: new Date().toISOString(),
        doc: structuredClone(doc),
        ...(meta?.author_id !== undefined ? { author_id: meta.author_id } : {}),
        ...(meta?.author_label !== undefined ? { author_label: meta.author_label } : {}),
        ...(meta?.author_note !== undefined ? { author_note: meta.author_note } : {}),
      };
      state.versions.push(snapshot);
      // Elke nieuwe versie bumpt lock_version — matcht de save-RPC.
      state.lockVersion = versionNumber;
      const { doc: _omit, ...summary } = snapshot;
      void _omit;
      return summary;
    },

    getCurrentLockVersion(projectDocumentId) {
      return ensure(projectDocumentId).lockVersion;
    },

    async list(projectDocumentId) {
      await wait();
      const state = store.get(projectDocumentId);
      if (!state) return [];
      // Nieuwste eerst (aflopend).
      return [...state.versions]
        .slice()
        .reverse()
        .map(({ doc: _doc, ...summary }) => {
          void _doc;
          return summary;
        });
    },

    async get(projectDocumentId, versionNumber) {
      await wait();
      const state = store.get(projectDocumentId);
      if (!state) return null;
      const hit = state.versions.find((v) => v.version_number === versionNumber);
      return hit ? { ...hit, doc: structuredClone(hit.doc) } : null;
    },

    async rollback(projectDocumentId, targetVersionNumber, expectedLockVersion): Promise<RollbackResult> {
      await wait();
      if (simulatedError) {
        const code = simulatedError;
        simulatedError = null;
        return { ok: false, error: code };
      }
      const state = store.get(projectDocumentId);
      if (!state) return { ok: false, error: 'not_found' };
      if (state.lockVersion !== expectedLockVersion) {
        return { ok: false, error: 'lock_version_mismatch' };
      }
      const target = state.versions.find((v) => v.version_number === targetVersionNumber);
      if (!target) return { ok: false, error: 'target_version_not_found' };
      if (target.doc.version !== state.schemaVersion) {
        return { ok: false, error: 'target_schema_version_incompatible' };
      }
      // Historie behouden — nooit muteren, alleen nieuwe versie toevoegen.
      // Rollback = nieuwe immutable versie met de teruggezette inhoud.
      const newVersionNumber = state.versions.length + 1;
      const restored: VersionSnapshot = {
        version_number: newVersionNumber,
        created_at: new Date().toISOString(),
        doc: structuredClone(target.doc),
        author_note: `rollback to version ${targetVersionNumber}`,
      };
      state.versions.push(restored);
      state.lockVersion = newVersionNumber;
      return {
        ok: true,
        new_lock_version: newVersionNumber,
        new_version_number: newVersionNumber,
      };
    },

    simulateNextRollbackError(code) {
      simulatedError = code;
    },

    __reset() {
      store.clear();
      simulatedError = null;
    },
  };
}
