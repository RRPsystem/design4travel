import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';

export function seedLandingPage(): DesignDoc {
  const now = new Date().toISOString();
  return {
    version: SCHEMA_VERSION,
    id: 'seed-landing',
    project: { documentType: 'website', title: 'Voorbeeld-landingspagina' },
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
          children: [
            {
              id: 'hero',
              type: 'hero',
              props: {
                title: 'Ontdek jouw volgende reis',
                subtitle: 'Handgemaakte reizen door onze specialisten.',
                imageSrc:
                  'https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=1600',
                overlay: true,
                height: 520,
                align: 'center',
              },
            },
            {
              id: 'section-a',
              type: 'layout-column',
              props: { gap: 12, padding: 32, align: 'start' },
              children: [
                {
                  id: 'section-a-title',
                  type: 'heading',
                  props: { text: 'Reizen op maat', level: 2 },
                },
                {
                  id: 'section-a-text',
                  type: 'text',
                  props: {
                    text: 'Van compacte stedentrip tot uitgebreide rondreis — wij regelen elk detail voor je.',
                  },
                },
              ],
            },
            {
              id: 'section-b',
              type: 'layout-column',
              props: { gap: 12, padding: 32, align: 'start' },
              children: [
                {
                  id: 'section-b-title',
                  type: 'heading',
                  props: { text: 'Persoonlijke begeleiding', level: 2 },
                },
                {
                  id: 'section-b-text',
                  type: 'text',
                  props: {
                    text: 'Onze reisspecialisten spreken de taal, kennen de bestemming en denken met je mee.',
                  },
                },
              ],
            },
            {
              id: 'cta',
              type: 'cta',
              props: {
                text: 'Plan je reis',
                href: '#plan',
                variant: 'primary',
                size: 'lg',
                align: 'center',
                color: '{brand.primary}',
              },
            },
          ],
        },
      },
    ],
  };
}
