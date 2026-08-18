/**
 * Studio4 Component SDK — types (contract v1.0).
 *
 * Mirroring van TravelBridgeAI's SectionProps + BrandData zodat Design4-side
 * (validator, preview-host) dezelfde vorm hanteert als de TravelBridgeAI-runtime.
 * Bron van deze definitie: `docs/travelbridgeai/baseline-2026-08-15.md`
 * (secties 1 en 3).
 *
 * WIJZIGINGEN aan deze types betekenen een SDK-versie-bump (breaking) en
 * moeten synchroon met TravelBridgeAI's `src/components/Site/sections/types.ts`.
 */

// -----------------------------------------------------------------------------
// Runtime-mirror types (moeten synchroon blijven met TravelBridgeAI)
// -----------------------------------------------------------------------------

/**
 * BrandData zoals TravelBridgeAI het aan iedere sectie doorgeeft.
 * Bron: TravelBridgeAI `src/components/Site/SiteLayout.tsx` lines 136-170.
 * Alleen velden opgenomen die Design4-gegenereerde componenten mogen consumeren
 * — netwerk-slug, analytics_id, certificaat-nummers e.d. zijn Studio4-intern.
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

/**
 * SectionProps — het contract dat elke Studio4-sectie ontvangt.
 * Bron: TravelBridgeAI `src/components/Site/sections/types.ts`.
 * Design4-gegenereerde componenten MOETEN deze signature accepteren.
 */
export interface SectionProps {
  brand: BrandData;
  primaryColor: string;
  secondaryColor?: string;
  basePath: string;
  /** Sub-map van pageContent voor deze specifieke sectie (JSONB uit DB). */
  pageContent: Record<string, unknown>;
  destinations?: unknown[];
  travels?: unknown[];
  agents?: unknown[];
  newsItems?: unknown[];
  advisors?: unknown[];
  /**
   * Optionele brand-override styling (background/padding/overlay) door
   * TravelBridgeAI's `mergeSectionRoot()` helper. Design4-componenten die
   * dit consumeren MOETEN `mergeSectionRoot` importeren uit
   * `../../lib/sectionStyle`.
   */
  sectionStyle?: unknown;
  /**
   * Resolved image-asset-URLs, gemapt op de `assets[].key` uit manifest.json.
   * Design4-preview/-sandbox levert deze map uit `resolved-assets.json`
   * (post-canonical gegenereerd door sandbox-build-trigger). TravelBridgeAI-
   * runtime kan dezelfde vorm leveren uit brand-media of Studio4-gateway.
   *
   * Kritiek: component-code die door canonical validator goedgekeurd wordt,
   * blijft byte-exact. URLs verschijnen ALLEEN via deze prop, nooit door
   * post-canonical string-manipulatie van de TSX.
   */
  assets?: Record<string, string>;
}

// -----------------------------------------------------------------------------
// SDK-side manifest types
// -----------------------------------------------------------------------------

/**
 * `manifest.json` bij elk Design4-gegenereerd component-pakket. AI genereert
 * deze — validator (server-side, versie-gebonden) accepteert of weigert.
 *
 * Belangrijk: velden zoals `requestedImports` zijn AI-WENSEN, geen policy.
 * De feitelijke import-whitelist is `POLICY_V1_0.allowedImports`
 * (zie `./policy-v1_0.ts`).
 */
export interface Studio4ComponentManifest {
  /** SDK-versie die dit pakket verwacht. Bepaalt welke policy geldt. */
  sdkVersion: '1.0';
  /** Stabiel pakket-ID, `kebab-case-versie`. */
  id: string;
  /** Human-readable naam (mag Nederlands zijn). */
  displayName: string;
  /** PascalCase component-naam, moet gelijk zijn aan `fileName` zonder `.tsx`. */
  componentName: string;
  /** Bestandsnaam van de TSX (PascalCase, .tsx). */
  fileName: string;
  /** snake_case key voor `SECTION_REGISTRY` in TravelBridgeAI. */
  registryKey: string;
  /** Vrije categorie-hint voor UI-groepering, geen enumeratie. */
  category: string;

  producedBy: {
    engine: 'studio4-component' | 'pdf-template';
    iteration: number;
    parentCallId: string;
    sourceReferenceId: string;
  };

  /**
   * Imports die de AI wil gebruiken. Validator matcht dit tegen
   * `POLICY_V1_0.allowedImports`; onvergunde imports = reject.
   */
  requestedImports: string[];

  /** Welke velden de component uit brand/pageContent verwacht. */
  consumes: {
    brand?: string[];
    primaryColor?: boolean;
    secondaryColor?: boolean;
    pageContent?: string[];
    sectionStyle?: boolean;
  };

  /** Media-slots die de component definieert. */
  media?: Array<{
    role: string;
    kind: 'image' | 'video';
    minWidth?: number;
    cutout?: boolean;
    optional?: boolean;
    domainsRequested?: string[];
  }>;

  /**
   * Asset-manifest voor image-URLs. Component gebruikt `props.assets['<key>']`;
   * validator cross-checkt dat elke `assets['x']`-referentie in de TSX een
   * matchende declaratie hier heeft. Design4-backend genereert een
   * resolved-assets.json (key→URL) via media-search NA canonical validatie.
   *
   * Query = 2-6 zoekwoorden voor beeldbank-lookup ("safari sunset kruger").
   */
  assets?: Array<{
    key: string;
    query: string;
    role?: 'hero-bg' | 'card' | 'gallery' | 'inline' | 'background';
  }>;

  /** Page-level hints — reviewer-taak om SiteLayout op te zetten. */
  pageLevel?: {
    requiresTransparentNav?: boolean;
    recommendedPage?: string;
    reviewerNote?: string;
  };

  responsive?: {
    breakpoints: Array<'sm' | 'md' | 'lg' | 'xl' | '2xl'>;
    mobileStrategy?: string;
  };

  a11y?: {
    landmarks?: string[];
    supportsReducedMotion?: boolean;
  };
}

// -----------------------------------------------------------------------------
// Policy types (implementatie in `./policy-v1_0.ts`)
// -----------------------------------------------------------------------------

export interface SdkPolicy {
  version: '1.0';
  allowedImports: readonly string[];
  forbiddenGlobals: readonly string[];
  requiresSsrGuard: readonly string[];
  allowedImageDomains: readonly string[];
  componentContract: {
    exportKind: 'named';
    exportNameMustMatchFileName: true;
    propsInterface: 'SectionProps';
    returnType: 'ReactElement | null';
    hooksBeforeEarlyReturn: true;
  };
  stylingContract: {
    system: 'tailwind-3.4-standard';
    disallowedInlineFeatures: readonly string[];
  };
  imageContract: {
    mustUseHelpers: readonly string[];
    forbidUnwhitelistedDomains: true;
    requireSrcSetSizes: true;
  };
  pageIntegrationHints: {
    transparentNav: 'requires-page-level';
    seoLcpPreload: 'may-suggest-meta-seed';
  };
}

// -----------------------------------------------------------------------------
// Validator result types
// -----------------------------------------------------------------------------

export interface ValidationIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  location?: { file?: string; line?: number; column?: number };
}

export interface ValidationResult {
  ok: boolean;
  manifest?: Studio4ComponentManifest;
  issues: ValidationIssue[];
  /** Totaal aantal errors — validator faalt als > 0. */
  errorCount: number;
  warningCount: number;
}
