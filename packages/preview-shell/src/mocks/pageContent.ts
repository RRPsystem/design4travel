import travelFixture from '../fixtures/travel.json';

/**
 * PageContent-sub-map voor de gemounte sectie. Preview-shell haalt
 * eventuele hero-content uit de canonical travel-fixture (title en tagline)
 * en vult de rest met representatieve waardes. Volstaat voor
 * demo-doeleinden; echte pageContent komt in productie uit
 * TravelBridgeAI's `page_sections.content` (JSONB).
 */

export const MOCK_PAGE_CONTENT = {
  hero: {
    title: travelFixture.title,
    subtitle: 'Kruger National Park & de witte stranden van Mauritius — 14 dagen',
    backgroundText: 'SAFARI',
    ctaLabel: 'Vraag offerte aan',
  },
};
