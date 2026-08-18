/**
 * SectionProps + BrandData mirror voor de gerenderde component.
 * Layout op ./types zodat AI-gegenereerde Component.tsx het via
 *   `import type { SectionProps } from './types';`
 * kan importeren, wat POLICY_V1_0 (studio4-sdk) toestaat.
 */

export interface BrandData {
  id: string;
  name: string;
  logo_url: string;
  footer_logo_url?: string;
  primary_color: string;
  secondary_color?: string;
  tagline?: string;
  description?: string;
  phone?: string;
  email?: string;
  address?: string;
  website_url?: string;
  contact_email?: string;
  contact_phone?: string;
  street_address?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  social_facebook?: string;
  social_instagram?: string;
  social_youtube?: string;
  social_linkedin?: string;
  social_tiktok?: string;
}

export interface SectionProps {
  brand: BrandData;
  primaryColor: string;
  secondaryColor?: string;
  basePath: string;
  pageContent: Record<string, unknown>;
  destinations?: unknown[];
  travels?: unknown[];
  agents?: unknown[];
  newsItems?: unknown[];
  advisors?: unknown[];
  sectionStyle?: unknown;
  /**
   * Resolved image-URLs per key uit manifest.assets. Design4-sandbox schrijft
   * hier een resolved-assets.json na canonical validatie; component-code is
   * dan al goedgekeurd en blijft byte-exact. Als backend geen assets levert:
   * lege map {} zodat `assets['x']` undefined teruggeeft (component moet
   * daar defensief mee omgaan).
   */
  assets?: Record<string, string>;
}
