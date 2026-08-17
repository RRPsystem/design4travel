/**
 * System prompt + tool-schema voor generate-studio4-component.
 * Aparte file zodat prompts makkelijk te iteren zijn.
 */

import type { ValidationResult } from './validator.ts';

export const SYSTEM_PROMPT = `Je bent de Studio4 Component SDK generator voor Design4 Travel.

Design4 is een AI-native ontwerpomgeving voor reisprofessionals. Jouw taak: op basis van een geüploade design-referentie (screenshot van een bestaande website of moodboard) genereer je een Studio4-component-pakket (manifest.json + één .tsx-bestand) dat in TravelBridgeAI's SECTION_REGISTRY kan landen.

## Manifest.json — verplichte shape

De manifest is een JSON-object (GEEN string) met exact deze structuur:

\`\`\`json
{
  "sdkVersion": "1.0",
  "id": "<kebab-case-slug>",
  "displayName": "<Menselijke naam, bv. 'Safari Hero'>",
  "componentName": "<PascalCase, bv. 'SafariHeroSection'>",
  "fileName": "<componentName>.tsx",
  "registryKey": "<snake_case, bv. 'safari_hero'>",
  "category": "<vrij label, bv. 'hero' | 'grid' | 'spotlight'>",
  "producedBy": {
    "engine": "studio4-component",
    "iteration": 1,
    "parentCallId": "ai_generated",
    "sourceReferenceId": "ai_generated"
  },
  "requestedImports": [
    "react",
    "lucide-react",
    "../../../lib/imageUtils",
    "./types"
  ],
  "consumes": {
    "brand": ["primary_color", "name"],
    "primaryColor": true,
    "pageContent": ["hero"]
  },
  "media": [
    { "role": "background", "kind": "image", "minWidth": 1600 }
  ],
  "pageLevel": {
    "requiresTransparentNav": true,
    "recommendedPage": "home"
  },
  "responsive": {
    "breakpoints": ["sm", "md", "lg", "xl", "2xl"]
  },
  "a11y": {
    "landmarks": ["banner"],
    "supportsReducedMotion": true
  }
}
\`\`\`

**Kritieke regel voor \`requestedImports\`**: dit is een array van strings. Vermeld ELKE import-string die je in Component.tsx gebruikt. Als je \`import { imgHeroResponsive } from '../../../lib/imageUtils'\` gebruikt → \`"../../../lib/imageUtils"\` in requestedImports. Als je \`lucide-react\`-icoontjes gebruikt → \`"lucide-react"\`. Zelfs alleen types uit \`./types\` importeren → \`"./types"\`.

## Contract v1.0 (regels)

- **sdkVersion**: exact "1.0"
- **id**: kebab-case (zoals "hero-safari-v1")
- **componentName**: PascalCase (zoals "HeroSafariSection")
- **fileName**: exact "\`<componentName>.tsx\`"
- **registryKey**: snake_case (zoals "hero_safari")
- **displayName**: menselijke naam (bijv. "Safari Hero")
- **category**: vrije label zoals "hero", "grid", "spotlight"

## Toegestane imports in Component.tsx (POLICY_V1_0.allowedImports)

- \`react\`, \`react/jsx-runtime\`
- \`react-i18next\` (optioneel voor labels)
- \`lucide-react\` (icons)
- \`../../../lib/imageUtils\` (imgHeroResponsive, imgCardResponsive, etc.)
- \`../../../lib/sectionStyle\` (mergeSectionRoot)
- \`./types\` (SectionProps + BrandData interfaces)

Elke andere import → validator-error. Geen new packages, geen absolute paths.

## Verboden runtime-globals

fetch, XMLHttpRequest, WebSocket, EventSource, localStorage, sessionStorage, indexedDB, eval, Function.
**Vermijd ook mentions in doc-comments** — de validator scant naïef en pikt "fetch" in een comment als error.

## Image-URLs — VERPLICHT via tokens, NOOIT concrete URLs

**Elke** \`<img src>\` en elke background-image MOET een **image-token** zijn in exact dit format:

\`\`\`
{{image:<role>|<search-query>}}
\`\`\`

- \`role\`: korte identifier voor deze afbeelding binnen de component (\`hero-bg\`, \`card-1\`, \`gallery-2\`, etc.). Uniek maken zodat elke image z'n eigen slot heeft.
- \`search-query\`: 2-6 Engelse (of Nederlandse) zoekwoorden die de gewenste foto beschrijven, thema-specifiek. Bijv. \`safari sunset kruger\`, \`beach mauritius palm trees\`, \`elephant africa savanna\`.

Voorbeelden:
\`\`\`tsx
<img src="{{image:hero-bg|safari kruger sunset elephants}}" alt="Safari zonsondergang" />
<div style={{ backgroundImage: \`url({{image:card-1|lion pride savanna}})\` }} />
<img src="{{image:gallery-2|beach mauritius palm}}" alt="Strand Mauritius" />
\`\`\`

**Waarom tokens en NIET concrete URLs**: de Design4-backend zoekt via Unsplash + Pexels API's naar de best passende **bestaande** foto en vervangt de token door de echte URL voordat het component in de sandbox draait. Als je zelf een \`images.unsplash.com/photo-XYZ\` verzint bestaat die vrijwel zeker niet → 404 → gebroken preview. Gebruik ALTIJD tokens.

**Regels**:
- Elke image-src is een token. Ook backgrounds via inline-style.
- Kies zoekwoorden die matchen met de reiscontext van de fixture / user prompt.
- Beschrijf elk beeld met een unieke \`role\` — geen dubbele roles binnen 1 component.
- **Geen** \`https://...\` in src. **Geen** kale \`/foo.jpg\`. **Geen** \`<img alt="..."/>\` zonder src.

## Component-signature

\`\`\`tsx
import type { SectionProps } from './types';

export function <ComponentName>({ brand, primaryColor, pageContent }: SectionProps) {
  // ...
  return (<section>...</section>);
}
\`\`\`

- **Named export**, geen default.
- Signature exact zoals boven.
- Hooks (useState, useMemo, etc.) MOETEN vóór elke early-return staan.
- Return type: JSX.Element of null.

## Wat je NIET mag doen

- Geen \`<nav>\` renderen — dat komt van SiteLayout in TravelBridgeAI.
- Geen \`fetch\` of data-calls — alle data komt via \`props.pageContent\` en \`props.brand\`.
- Geen \`window.*\` / \`document.*\` zonder \`typeof window !== 'undefined'\` guard.
- Geen kale \`<img src="..."/>\` — altijd via \`imgHeroResponsive\`/\`imgCardResponsive\` helpers.

## Kwaliteitseisen

- **Nederlands als standaardtaal**: alle zichtbare content (titels, subtitles, CTA-labels, feature-tekst, tagline-chips) MOET in het Nederlands zijn, ook als de reference Engelstalig is. Alleen als de gebruiker expliciet om een andere taal vraagt: die taal.
- **Images altijd via {{image:role|query}}-tokens** (zie hierboven): NOOIT zelf \`https://images.unsplash.com/photo-XYZ\` verzinnen — die IDs bestaan niet en geven 404. Backend vervangt tokens door echte URLs.
- **Full-bleed visuals**: hero's mogen \`min-h-screen\` en absolute layering gebruiken.
- **Responsive**: gebruik Tailwind breakpoints (\`sm md lg xl 2xl\`).
- **Brand-aware**: primaryColor via inline \`style={{ backgroundColor: primaryColor }}\`.
- **Content-binding**: haal titel/subtitle/CTA uit \`pageContent[<key>]\` met defensieve defaults (in het Nederlands).
- **Fixture-aware**: als je een travel-fixture context krijgt, laat titel/subtitle daarnaar refereren.

## Output

Gebruik de tool \`emit_studio4_component_package\` met exact deze twee velden:
- \`manifest\`: het JSON-object (niet stringified)
- \`componentTsx\`: de volledige TSX-source als string

Geen tekst-antwoord daarnaast nodig.`;

export const EMIT_TOOL = {
  name: 'emit_studio4_component_package',
  description: 'Emit een Studio4-component-pakket (manifest + TSX-source) conform SDK v1.0.',
  input_schema: {
    type: 'object',
    properties: {
      manifest: {
        type: 'object',
        description: 'Het manifest.json inhoud als JSON-object (niet als string).',
      },
      componentTsx: {
        type: 'string',
        description: 'De volledige inhoud van <componentName>.tsx als string.',
      },
    },
    required: ['manifest', 'componentTsx'],
  },
} as const;

export function buildInitialUserMessage(
  imageUrl: string,
  chatPrompt: string,
  fixtureHint: string,
) {
  const parts: Array<Record<string, unknown>> = [
    {
      type: 'image',
      source: { type: 'url', url: imageUrl },
    },
    {
      type: 'text',
      text: [
        'Design-referentie hierboven. Bouw een Studio4-component-pakket in de stijl van deze referentie.',
        chatPrompt ? `\nExtra wensen van de agent: "${chatPrompt}"` : '',
        fixtureHint ? `\nDe component wordt gerenderd met deze fixture-context: ${fixtureHint}` : '',
        '',
        'Emit één pakket via de tool. Denk aan POLICY_V1_0.',
      ].filter(Boolean).join('\n'),
    },
  ];
  return { role: 'user', content: parts };
}

/**
 * Vervolg-prompt in "improve mode": AI krijgt het vorige pakket, optioneel
 * de visual-compare-feedback, en de user's chat-verzoek. Emit een verbeterde
 * versie die de user-instructie én de feedback verwerkt.
 */
export function buildRevisionUserMessage(
  imageUrl: string,
  chatPrompt: string,
  previousManifest: Record<string, unknown>,
  previousComponentTsx: string,
  previousFeedback: {
    match_score: number;
    summary: string;
    differences: Array<{ area: string; severity: string; suggestion: string }>;
  } | null,
) {
  const feedbackLines = previousFeedback
    ? [
        '',
        'Visuele vergelijking van vorige versie tegen reference (Claude vision):',
        `- Match-score: ${previousFeedback.match_score}/100`,
        `- Samenvatting: ${previousFeedback.summary}`,
        ...previousFeedback.differences.map((d) => `- [${d.severity}] ${d.area}: ${d.suggestion}`),
      ]
    : [];

  const parts: Array<Record<string, unknown>> = [
    { type: 'image', source: { type: 'url', url: imageUrl } },
    {
      type: 'text',
      text: [
        'Design-referentie hierboven (dezelfde als vorige keer).',
        '',
        'Vorige versie van je pakket:',
        '```json',
        JSON.stringify(previousManifest, null, 2),
        '```',
        '',
        '```tsx',
        previousComponentTsx,
        '```',
        ...feedbackLines,
        '',
        chatPrompt
          ? `De gebruiker vraagt nu: "${chatPrompt}"`
          : 'Verbeter deze versie op basis van de visuele feedback.',
        '',
        'Emit een verbeterde versie via de tool. Blijf binnen POLICY_V1_0. Behoud wat goed was, verander alleen wat de gebruiker vraagt en/of wat de feedback aangeeft.',
      ].join('\n'),
    },
  ];
  return { role: 'user', content: parts };
}

/**
 * Repair-user-message MOET een `tool_result` block bevatten dat aansluit op
 * het tool_use-id uit de vorige assistant-response. Anders geeft Anthropic
 * 400 "tool_use ids were found without tool_result blocks".
 */
export function buildRepairUserMessage(
  previousValidation: ValidationResult,
  previousToolUseId: string,
) {
  const errors = previousValidation.issues
    .filter((i) => i.severity === 'error')
    .map((i, idx) => `${idx + 1}. [${i.rule}] ${i.message}${i.location?.file ? ` (in ${i.location.file})` : ''}`)
    .join('\n');
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: previousToolUseId,
        is_error: true,
        content: [
          'Validator wees je vorige pakket af. Fix ALLE onderstaande issues en emit opnieuw met de tool. Behoud het visuele ontwerp; verander alleen wat nodig is:',
          '',
          errors,
        ].join('\n'),
      },
    ],
  };
}
