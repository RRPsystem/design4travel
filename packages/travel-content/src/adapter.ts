import type { TravelContent, TravelSourceKind } from './schema.js';

/**
 * ContentSourceAdapter — één interface, meerdere implementaties per bron-type.
 *
 * Iedere adapter is verantwoordelijk voor:
 *   1. Raw bron ophalen (fixture: fs read; travel_compositor: HTTP-call met
 *      server-side key; studio4_content: HTTP-call naar Studio4-gateway;
 *      manual: form-input van user).
 *   2. Sanitiseren — verwijderen van API-keys, interne IDs, HTML, en alle
 *      bron-specifieke velden die niet in het TravelContent-schema thuishoren.
 *   3. Mappen naar TravelContent volgens schema v1.0.
 *
 * Wat NIET in de adapter thuishoort:
 *   - Persistence (aanroeper slaat op in content_sources tabel).
 *   - Auth-checks (Edge Function doet dat).
 *   - Business-decisies over welke bron voor welke user (dat is UI-keuze).
 */
export interface ContentSourceAdapter {
  readonly kind: TravelSourceKind;
  /**
   * @param sourceId Optioneel — voor fixture=slug, TC=record ID, manual=undefined.
   * @param sourceInput Optioneel — voor manual: raw form-values.
   */
  resolve(sourceId?: string, sourceInput?: unknown): Promise<TravelContent>;
}

export class ContentSourceError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ContentSourceError';
  }
}
