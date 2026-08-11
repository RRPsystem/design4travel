import type { RollbackErrorCode } from '@design4/design-doc';

/**
 * User-facing Nederlandse vertaling van elke publieke rollback-foutcode.
 * Codes komen 1-op-1 uit de rollback-document Edge Function (A3.2).
 * Onbekende codes vallen terug op `internal_error`.
 */
export function messageForRollbackError(code: RollbackErrorCode): string {
  switch (code) {
    case 'lock_version_mismatch':
      return 'Het document is intussen gewijzigd. Sluit de versiegeschiedenis, ververs en probeer het opnieuw.';
    case 'target_version_not_found':
      return 'Deze versie is niet meer beschikbaar.';
    case 'target_schema_version_incompatible':
      return 'Deze versie is gemaakt in een oudere editorversie en kan niet meer worden hersteld.';
    case 'insufficient_role':
      return 'Je hebt niet de juiste rol om deze versie te herstellen.';
    case 'membership_not_active':
      return 'Je bent geen actief lid meer van deze werkruimte.';
    case 'organization_not_active':
      return 'De werkruimte is niet meer actief.';
    case 'project_not_active':
      return 'Dit project is niet meer actief.';
    case 'not_found':
      return 'Het document is niet gevonden.';
    case 'invalid_user_token':
    case 'missing_authorization':
      return 'Je sessie is verlopen. Log opnieuw in en probeer het opnieuw.';
    case 'invalid_request':
    case 'invalid_json':
      return 'Het verzoek is ongeldig.';
    case 'payload_too_large':
      return 'Het verzoek is te groot.';
    case 'method_not_allowed':
      return 'Deze actie is niet toegestaan.';
    case 'internal_error':
      return 'Er is een technisch probleem opgetreden. Probeer het later opnieuw.';
  }
}
