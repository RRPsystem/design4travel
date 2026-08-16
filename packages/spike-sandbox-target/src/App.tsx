import { SafariHeroSection } from './components/SafariHeroSection';
import travelFixture from './fixtures/travel.json';
import type { BrandData } from './components/types';

/**
 * App-root voor de spike-target. Mount SafariHeroSection met een mock-brand
 * en pageContent afgeleid uit de canonical safari-fixture. Bewijst binding
 * `pageContent.hero.title ← fixture.title` end-to-end door de sandbox-build.
 */

const mockBrand: BrandData = {
  id: 'brand-design4-mock',
  name: 'Design4 Travel',
  logo_url: '',
  primary_color: '#c47a2b',
  secondary_color: '#1a3a52',
  tagline: 'Rondreis-experts sinds 2018',
  phone: '+31 20 123 4567',
};

const pageContent = {
  hero: {
    title: travelFixture.title,
    subtitle: 'Kruger National Park & de witte stranden van Mauritius — 14 dagen',
    backgroundText: 'SAFARI',
    ctaLabel: 'Vraag offerte aan',
  },
};

export default function App() {
  return (
    <SafariHeroSection
      brand={mockBrand}
      primaryColor={mockBrand.primary_color}
      secondaryColor={mockBrand.secondary_color}
      basePath="/"
      pageContent={pageContent}
    />
  );
}
