/**
 * Mock pageContent-sub-map voor de gemounte sectie. In TravelBridgeAI komt dit
 * uit `page_sections.content` (JSONB). Preview-host levert het handmatig.
 *
 * Voor de eerste demo-sectie (`HelloSection`) gebruiken we `pageContent.hello`;
 * voor toekomstige safari-hero-tests kunnen we `pageContent.hero` toevoegen.
 */
export const MOCK_PAGE_CONTENT = {
  hello: {
    title: 'Preview-host werkt',
    subtitle: 'Studio4-SDK contract v1.0 gemount met mock SiteLayout, brand en pageContent.',
    cta: 'Ga verder',
  },
  hero: {
    title: 'Safari van je leven',
    subtitle: 'Kruger National Park & de witte stranden van Mauritius — 14 dagen',
    backgroundText: 'SAFARI',
    ctaLabel: 'Vraag offerte aan',
  },
};
