import { SCHEMA_VERSION, type DesignDoc, type NodeInstance } from '@design4/design-doc';
import type { TravelContent } from '@design4/travel-content/schema';

export interface SeedInput {
  travel: TravelContent;
  contentSourceId: string;
  documentType: DesignDoc['project']['documentType'];
  documentTitle: string;
}

/**
 * Bouw een deterministisch DesignDoc uit een resolved TravelContent.
 *
 * Deze seed is bewust simpel: hero + intro + bestemmingen-lijst + hotels-lijst
 * + prijs-CTA. Het is een startpunt dat de gebruiker via chat verder vormgeeft;
 * niet een "af" ontwerp. Wat hier ontbreekt (afbeeldingen, kleuren, layout-
 * varianten, brand-tokens) is precies waar de AI aan gaat werken zodra de
 * user een prompt geeft.
 *
 * Redenen voor deterministisch i.p.v. AI-gegenereerd:
 *   1. Voorspelbaar — dezelfde reis geeft altijd hetzelfde startpunt.
 *   2. Snel — geen Anthropic-call bij document-creatie.
 *   3. Geen kosten voor iets dat de user vrijwel zeker direct gaat wijzigen.
 *
 * `contentSourceId` wordt in `project.contentSourceId` gezet (zie PR-1) zodat
 * `generate-patch` de bijbehorende content_sources-rij kan laden voor context
 * (zie PR-2).
 */
export function seedFromTravelContent(input: SeedInput): DesignDoc {
  const { travel, contentSourceId, documentType, documentTitle } = input;
  const now = new Date().toISOString();

  const children: NodeInstance[] = [];

  // -- Hero ---------------------------------------------------------------
  const heroSubtitle = travel.subtitle
    ?? [
      travel.days ? `${travel.days} dagen` : null,
      travel.countries.length > 0 ? travel.countries.join(' · ') : null,
    ].filter((s): s is string => s !== null).join(' · ');

  children.push({
    id: 'hero',
    type: 'hero',
    props: {
      title: travel.title,
      subtitle: heroSubtitle || 'Uw reis',
      overlay: true,
      height: 520,
      align: 'center',
    },
  });

  // -- Intro (optioneel) --------------------------------------------------
  if (travel.intro) {
    children.push({
      id: 'intro-section',
      type: 'layout-column',
      props: { gap: 12, padding: 32, align: 'start' },
      children: [
        { id: 'intro-text', type: 'text', props: { text: travel.intro } },
      ],
    });
  }

  // -- Bestemmingen -------------------------------------------------------
  if (travel.destinations.length > 0) {
    const destChildren: NodeInstance[] = [
      { id: 'dest-heading', type: 'heading', props: { text: 'Bestemmingen', level: 2 } },
    ];
    travel.destinations.forEach((d, i) => {
      const dayRange = d.from_day !== undefined && d.to_day !== undefined
        ? ` (dag ${d.from_day}–${d.to_day})`
        : '';
      const destChildrenInner: NodeInstance[] = [
        {
          id: `dest-${i}-title`,
          type: 'heading',
          props: { text: `${d.name}${dayRange}`, level: 3 },
        },
      ];
      if (d.description) {
        destChildrenInner.push({
          id: `dest-${i}-desc`,
          type: 'text',
          props: { text: d.description },
        });
      }
      destChildren.push({
        id: `dest-${i}`,
        type: 'layout-column',
        props: { gap: 6, align: 'start' },
        children: destChildrenInner,
      });
    });
    children.push({
      id: 'destinations',
      type: 'layout-column',
      props: { gap: 24, padding: 32, align: 'start' },
      children: destChildren,
    });
  }

  // -- Hotels (optioneel) -------------------------------------------------
  if (travel.hotels && travel.hotels.length > 0) {
    const hotelChildren: NodeInstance[] = [
      { id: 'hotels-heading', type: 'heading', props: { text: 'Uw hotels', level: 2 } },
    ];
    travel.hotels.forEach((h, i) => {
      const nightsLabel = ` — ${h.nights} nacht${h.nights === 1 ? '' : 'en'}`;
      hotelChildren.push({
        id: `hotel-${i}`,
        type: 'layout-column',
        props: { gap: 4, align: 'start' },
        children: [
          {
            id: `hotel-${i}-city`,
            type: 'heading',
            props: { text: h.city, level: 3 },
          },
          {
            id: `hotel-${i}-name`,
            type: 'text',
            props: { text: `${h.name}${nightsLabel}` },
          },
        ],
      });
    });
    children.push({
      id: 'hotels',
      type: 'layout-column',
      props: { gap: 20, padding: 32, align: 'start' },
      children: hotelChildren,
    });
  }

  // -- Prijs CTA (optioneel) ---------------------------------------------
  if (travel.price) {
    children.push({
      id: 'price-cta',
      type: 'cta',
      props: {
        text: `Vanaf ${travel.price.amount} ${travel.price.currency}`,
        href: '#plan',
        variant: 'primary',
        size: 'lg',
        align: 'center',
        color: '{brand.primary}',
      },
    });
  }

  return {
    version: SCHEMA_VERSION,
    id: 'seed-travel',
    project: {
      documentType,
      title: documentTitle,
      contentSourceId,
    },
    meta: { createdAt: now, updatedAt: now },
    brandTokens: { 'brand.primary': '#4f46e5', 'brand.accent': '#f97316' },
    outputs: { web: { enabled: true } },
    pages: [
      {
        id: 'page-1',
        name: 'Home',
        root: {
          id: 'root',
          type: 'layout-column',
          props: { gap: 48, padding: 0, maxWidth: 1200 },
          children,
        },
      },
    ],
  };
}
