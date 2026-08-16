/**
 * Mimicks TravelBridgeAI's SectionProps + BrandData shape (bewijst dat de spike-target
 * dezelfde vorm gebruikt zonder dat we TravelBridgeAI-broncode nodig hebben).
 * Bron: zie `docs/travelbridgeai/baseline-2026-08-15.md` — sectie 1.
 */

export interface BrandData {
  id: string;
  name: string;
  logo_url: string;
  primary_color: string;
  secondary_color?: string;
  tagline?: string;
  phone?: string;
  email?: string;
}

export interface SectionProps {
  brand: BrandData;
  primaryColor: string;
  secondaryColor?: string;
  basePath: string;
  pageContent: Record<string, unknown>;
  destinations?: unknown[];
  travels?: unknown[];
}
