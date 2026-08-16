/**
 * Inline validator — minimale variant van packages/studio4-sdk/src/validator.ts.
 * Alleen wat de Edge Function nodig heeft: manifest-shape + import-whitelist +
 * forbidden-globals + image-domains. Zwaarder werk (AST-scan) volgt in iteratie 4c.2.
 */

import type { SdkPolicy } from './policy.ts';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  location?: { file?: string };
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
}

interface Manifest {
  sdkVersion?: string;
  id?: string;
  displayName?: string;
  componentName?: string;
  fileName?: string;
  registryKey?: string;
  category?: string;
  producedBy?: unknown;
  requestedImports?: string[];
  consumes?: unknown;
  media?: unknown[];
  pageLevel?: unknown;
  responsive?: unknown;
  a11y?: unknown;
}

const KEBAB = /^[a-z][a-z0-9-]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const IDENTIFIER_BOUNDARY = /[A-Za-z0-9_$]/;
const URL_REGEX = /https?:\/\/([^\s"'`)]+)/g;

function containsIdentifier(source: string, name: string): boolean {
  let idx = source.indexOf(name);
  while (idx !== -1) {
    const before = idx > 0 ? source[idx - 1] : '';
    const after = idx + name.length < source.length ? source[idx + name.length] : '';
    if (!IDENTIFIER_BOUNDARY.test(before ?? '') && !IDENTIFIER_BOUNDARY.test(after ?? '')) return true;
    idx = source.indexOf(name, idx + 1);
  }
  return false;
}

export function validatePackage(
  files: { manifestJson: string; componentTsx: string },
  policy: SdkPolicy,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // 1. Manifest-shape
  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(files.manifestJson) as Manifest;
  } catch (e) {
    issues.push({
      severity: 'error', rule: 'manifest.invalid-json',
      message: `manifest.json niet parseable: ${(e as Error).message}`,
      location: { file: 'manifest.json' },
    });
  }

  if (manifest) {
    if (manifest.sdkVersion !== '1.0') {
      issues.push({ severity: 'error', rule: 'manifest.sdkVersion', message: `sdkVersion moet '1.0' zijn, was: ${manifest.sdkVersion}`, location: { file: 'manifest.json' } });
    }
    if (!manifest.id || !KEBAB.test(manifest.id)) {
      issues.push({ severity: 'error', rule: 'manifest.id', message: 'id moet kebab-case', location: { file: 'manifest.json' } });
    }
    if (!manifest.componentName || !PASCAL.test(manifest.componentName)) {
      issues.push({ severity: 'error', rule: 'manifest.componentName', message: 'componentName moet PascalCase', location: { file: 'manifest.json' } });
    }
    if (!manifest.registryKey || !SNAKE.test(manifest.registryKey)) {
      issues.push({ severity: 'error', rule: 'manifest.registryKey', message: 'registryKey moet snake_case', location: { file: 'manifest.json' } });
    }
    if (manifest.fileName && manifest.componentName && manifest.fileName !== `${manifest.componentName}.tsx`) {
      issues.push({ severity: 'error', rule: 'manifest.fileName', message: `fileName moet '${manifest.componentName}.tsx' zijn`, location: { file: 'manifest.json' } });
    }
    if (!manifest.displayName) {
      issues.push({ severity: 'error', rule: 'manifest.displayName', message: 'displayName ontbreekt', location: { file: 'manifest.json' } });
    }
    if (!manifest.category) {
      issues.push({ severity: 'error', rule: 'manifest.category', message: 'category ontbreekt', location: { file: 'manifest.json' } });
    }

    // 2. Import-whitelist
    if (Array.isArray(manifest.requestedImports)) {
      const allowed = new Set(policy.allowedImports);
      for (const req of manifest.requestedImports) {
        if (!allowed.has(req)) {
          issues.push({
            severity: 'error', rule: 'policy.import-not-allowed',
            message: `Import "${req}" niet in policy.allowedImports (${policy.allowedImports.join(', ')})`,
            location: { file: 'manifest.json' },
          });
        }
      }
    } else {
      issues.push({ severity: 'error', rule: 'manifest.requestedImports', message: 'requestedImports moet een array zijn', location: { file: 'manifest.json' } });
    }
  }

  // 3. Forbidden globals in TSX (naïef — comments met de woorden triggeren ook)
  if (files.componentTsx) {
    for (const g of policy.forbiddenGlobals) {
      if (containsIdentifier(files.componentTsx, g)) {
        issues.push({
          severity: 'error', rule: 'policy.forbidden-global',
          message: `Component.tsx bevat referentie naar verboden global "${g}". Vermijd ook mentions in doc-comments.`,
          location: { file: 'Component.tsx' },
        });
      }
    }
  }

  // 4. Image-URL domain-scan
  if (files.componentTsx) {
    const matches = files.componentTsx.matchAll(URL_REGEX);
    for (const m of matches) {
      const host = (m[1] ?? '').split('/')[0] ?? '';
      const ok = policy.allowedImageDomains.some((d) => host === d || host.endsWith(`.${d}`));
      if (!ok) {
        issues.push({
          severity: 'error', rule: 'policy.image-domain-not-allowed',
          message: `URL naar "${host}" niet in policy.allowedImageDomains (${policy.allowedImageDomains.join(', ')})`,
          location: { file: 'Component.tsx' },
        });
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  return { ok: errorCount === 0, issues, errorCount, warningCount };
}
