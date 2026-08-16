import { ManifestSchema } from './manifest-schema.js';
import { POLICY_V1_0 } from './policy-v1_0.js';
import type {
  Studio4ComponentManifest,
  ValidationIssue,
  ValidationResult,
} from './types.js';

/**
 * Studio4 Component SDK — Validator (iteratie 1).
 *
 * Deze iteratie doet CHECKS die geen AST-parser nodig hebben:
 *   1. Manifest schema-validatie via Zod (`ManifestSchema.safeParse`).
 *   2. `requestedImports` matcht `POLICY_V1_0.allowedImports` exact.
 *   3. Text-scan van `Component.tsx` voor `forbiddenGlobals` (naïef, false-
 *      positives mogelijk; AST-scan komt in iteratie 2).
 *   4. URL-domein-scan: elke `http(s)://...` in de TSX moet in
 *      `allowedImageDomains` staan.
 *
 * Niet in deze iteratie (komt in iteratie 2 met @typescript-eslint/parser):
 *   - Echte AST-scan voor imports, exports, hook-volgorde
 *   - `requiresSsrGuard` check
 *   - Export-name-match met filename
 *
 * Doel iteratie 1: kunnen aantonen dat manifest-shape + import-whitelist +
 * eerste veiligheidsnet werken op AI-output, zonder dep op eslint-parser.
 */

export interface PackageFiles {
  manifestJson: string;
  componentTsx: string;
  /** Optioneel: componentCss, propsSchemaJson, fixtures, tests. */
  [otherFile: string]: string | undefined;
}

// -----------------------------------------------------------------------------
// Manifest-shape validatie
// -----------------------------------------------------------------------------

function validateManifestShape(
  manifestJson: string,
  issues: ValidationIssue[],
): Studio4ComponentManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch (e) {
    issues.push({
      severity: 'error',
      rule: 'manifest.json-invalid-json',
      message: `manifest.json is geen valide JSON: ${(e as Error).message}`,
      location: { file: 'manifest.json' },
    });
    return null;
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    for (const err of result.error.issues) {
      issues.push({
        severity: 'error',
        rule: `manifest.${err.code}`,
        message: `${err.path.join('.')}: ${err.message}`,
        location: { file: 'manifest.json' },
      });
    }
    return null;
  }
  return result.data as Studio4ComponentManifest;
}

// -----------------------------------------------------------------------------
// Requested imports vs. policy whitelist
// -----------------------------------------------------------------------------

function validateImportWhitelist(
  manifest: Studio4ComponentManifest,
  issues: ValidationIssue[],
): void {
  const allowed = new Set(POLICY_V1_0.allowedImports);
  for (const requested of manifest.requestedImports) {
    if (!allowed.has(requested)) {
      issues.push({
        severity: 'error',
        rule: 'policy.import-not-allowed',
        message: `Import "${requested}" is niet in POLICY_V1_0.allowedImports. Toegestaan: ${POLICY_V1_0.allowedImports.join(', ')}`,
        location: { file: 'manifest.json' },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Text-scan Component.tsx (naïef; AST komt in iteratie 2)
// -----------------------------------------------------------------------------

const IDENTIFIER_BOUNDARY = /[A-Za-z0-9_$]/;

function containsIdentifier(source: string, name: string): boolean {
  // Naïeve identifier-detectie: character voor en na moet NIET-identifier zijn.
  // AST-scan is beter maar vereist parser (iteratie 2).
  let idx = source.indexOf(name);
  while (idx !== -1) {
    const before = idx > 0 ? source[idx - 1] : '';
    const after = idx + name.length < source.length ? source[idx + name.length] : '';
    if (!IDENTIFIER_BOUNDARY.test(before ?? '') && !IDENTIFIER_BOUNDARY.test(after ?? '')) {
      return true;
    }
    idx = source.indexOf(name, idx + 1);
  }
  return false;
}

function validateForbiddenGlobals(
  componentTsx: string,
  issues: ValidationIssue[],
): void {
  for (const g of POLICY_V1_0.forbiddenGlobals) {
    if (containsIdentifier(componentTsx, g)) {
      issues.push({
        severity: 'error',
        rule: 'policy.forbidden-global',
        message: `Component.tsx bevat referentie naar verboden global "${g}". AST-verificatie in iteratie 2 zal false-positives (bijv. string-literals) elimineren.`,
        location: { file: 'Component.tsx' },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Image-URL domein-scan
// -----------------------------------------------------------------------------

const URL_REGEX = /https?:\/\/([^\s"'`)]+)/g;

function validateImageDomains(componentTsx: string, issues: ValidationIssue[]): void {
  const allowed = POLICY_V1_0.allowedImageDomains;
  const matches = componentTsx.matchAll(URL_REGEX);
  for (const m of matches) {
    const urlPath = m[1] ?? '';
    const host = urlPath.split('/')[0] ?? '';
    const okDomain = allowed.some((d) => host === d || host.endsWith(`.${d}`));
    if (!okDomain) {
      issues.push({
        severity: 'error',
        rule: 'policy.image-domain-not-allowed',
        message: `URL naar "${host}" niet in POLICY_V1_0.allowedImageDomains. Toegestaan: ${allowed.join(', ')}`,
        location: { file: 'Component.tsx' },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Publieke API
// -----------------------------------------------------------------------------

/**
 * Valideer een Design4-gegenereerd Studio4-component-pakket tegen SDK v1.0.
 *
 * @returns `ValidationResult` — `.ok === true` als er 0 errors zijn.
 *          Warnings zijn niet-blokkerend maar wel gerapporteerd.
 */
export function validatePackage(files: PackageFiles): ValidationResult {
  const issues: ValidationIssue[] = [];

  const manifest = validateManifestShape(files.manifestJson, issues);
  if (manifest) {
    validateImportWhitelist(manifest, issues);
  }
  if (files.componentTsx) {
    validateForbiddenGlobals(files.componentTsx, issues);
    validateImageDomains(files.componentTsx, issues);
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  return {
    ok: errorCount === 0,
    manifest: manifest ?? undefined,
    issues,
    errorCount,
    warningCount,
  };
}
