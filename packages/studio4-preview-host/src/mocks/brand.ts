import type { BrandData } from '@design4/studio4-sdk';

/**
 * Mock BrandData voor preview-host. Vervangbaar via URL-param of dev-UI in
 * latere iteratie zodat Design4-users hun eigen brand-JSON kunnen previewen.
 */
export const MOCK_BRAND: BrandData = {
  id: 'brand-design4-mock',
  name: 'Design4 Travel',
  logo_url: '',
  primary_color: '#c47a2b',
  secondary_color: '#1a3a52',
  tagline: 'Rondreis-experts sinds 2018',
  phone: '+31 20 123 4567',
  email: 'hallo@design4.travel',
  address: 'Prinsengracht 1, 1015 DR Amsterdam',
  website_url: 'https://design4.travel',
  social_instagram: 'design4travel',
  social_facebook: 'design4travel',
};
