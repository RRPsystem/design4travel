import { z } from 'zod';

/**
 * Text-align schema voor nodes die INHOUD (tekst, buttons, hero-titel)
 * horizontaal uitlijnen: cta, heading, hero, text.
 *
 * Accepteert canonical `left | center | right` PLUS flexbox-synoniemen
 * (`start → left`, `end → right`). Reden: AI kent twee align-conventies
 * (tekst vs flexbox) en verwart ze vaak — in prompts.ts staan tools als
 * `insert_node` waar de AI voor cta soms `'start'` genereert (uit gewoonte
 * van layout-column). Zonder deze normalisatie zou zo'n patch client-side
 * gerejected worden en het CTA-blok simpelweg niet verschijnen.
 *
 * De renderer krijgt altijd één van de drie canonical waarden — geen
 * downstream aanpassing nodig.
 *
 * NB: dit is een DEFENSIEVE laag, geen license om in prompts.ts sloppy te
 * documenteren. Ideaal blijft: de tool_use-schema aan Anthropic-kant strak.
 */
export const TextAlignSchema = z.preprocess(
  (v) => {
    if (v === 'start') return 'left';
    if (v === 'end') return 'right';
    return v;
  },
  z.enum(['left', 'center', 'right']),
);
export type TextAlign = z.infer<typeof TextAlignSchema>;
