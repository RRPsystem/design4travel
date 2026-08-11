import type { DesignDoc } from './schema.js';

/**
 * VersionHistoryAdapter — leest de historie van een document en voert een
 * rollback uit. Contract is 1-op-1 afgeleid van de Supabase-backend (migration
 * 0010 `rollback_to_version` + Edge Function `rollback-document` in A3.2),
 * zodat een toekomstige Supabase-implementatie dezelfde interface invult
 * zonder dat de UI hoeft te veranderen.
 *
 * De mock-implementatie in `apps/app/src/adapters/versions/mock.ts` bootst
 * exact hetzelfde contract (foutcodes + response-shape) na met in-memory
 * data, zodat UX + foutafhandeling in de frontend nu al testbaar zijn.
 */

export interface VersionSummary {
  /** 1-based versienummer, uniek binnen één document. */
  version_number: number;
  /** ISO 8601-tijdstempel van creatie. */
  created_at: string;
  /** UUID van de gebruiker die de versie heeft aangemaakt (indien bekend). */
  author_id?: string;
  /** Optioneel weergavelabel voor de auteur (bv. "Jij", "jan@example.com"). */
  author_label?: string;
  /** Optionele auteurs-notitie (bv. "rollback to version 3"). */
  author_note?: string;
}

export interface VersionSnapshot extends VersionSummary {
  /** Volledige inhoud van het document zoals bij deze versie bewaard. */
  doc: DesignDoc;
}

/**
 * Alle foutcodes die de rollback-flow publiek kan retourneren.
 * Matcht de allowlist uit `supabase/functions/rollback-document/schema.ts`
 * (RPC_ERROR_ALLOWLIST) plus de handler-level codes zoals
 * `missing_authorization`, `invalid_user_token`, `invalid_json`,
 * `invalid_request`, `payload_too_large`, `method_not_allowed`,
 * `internal_error`.
 *
 * Onbekende backend-fouten mappen we in de UI naar `internal_error`.
 */
export type RollbackErrorCode =
  | 'invalid_json'
  | 'invalid_request'
  | 'missing_authorization'
  | 'invalid_user_token'
  | 'method_not_allowed'
  | 'insufficient_role'
  | 'membership_not_active'
  | 'not_found'
  | 'target_version_not_found'
  | 'organization_not_active'
  | 'project_not_active'
  | 'lock_version_mismatch'
  | 'target_schema_version_incompatible'
  | 'payload_too_large'
  | 'internal_error';

export interface RollbackSuccess {
  ok: true;
  new_lock_version: number;
  new_version_number: number;
}
export interface RollbackFailure {
  ok: false;
  error: RollbackErrorCode;
}
export type RollbackResult = RollbackSuccess | RollbackFailure;

export interface VersionHistoryAdapter {
  /** Historie in aflopende volgorde (nieuwste eerst). */
  list(projectDocumentId: string): Promise<VersionSummary[]>;
  /** Eén versie ophalen inclusief documentinhoud; `null` als niet bestaat. */
  get(
    projectDocumentId: string,
    versionNumber: number,
  ): Promise<VersionSnapshot | null>;
  /**
   * Rollback naar een oudere versie. Maakt aan de backend-zijde altijd een
   * NIEUWE versie met de teruggezette inhoud (invariant uit migration 0010
   * stap G+H), zodat de huidige toestand automatisch bewaard blijft.
   */
  rollback(
    projectDocumentId: string,
    targetVersionNumber: number,
    expectedLockVersion: number,
  ): Promise<RollbackResult>;
}
