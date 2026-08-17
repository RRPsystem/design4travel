import { parse } from '@typescript-eslint/parser';
import type { TSESTree } from '@typescript-eslint/types';
import { ManifestSchema } from './manifest-schema.js';
import { POLICY_V1_0 } from './policy-v1_0.js';
import type {
  Studio4ComponentManifest,
  ValidationIssue,
  ValidationResult,
} from './types.js';

/**
 * Studio4 Component SDK — Validator (iteratie 2, AST-scan).
 *
 * Checks:
 *   1. Manifest schema-validatie via Zod (`ManifestSchema.safeParse`).
 *   2. `requestedImports` matcht `POLICY_V1_0.allowedImports` exact.
 *   3. AST-scan van `Component.tsx` voor `forbiddenGlobals`: alleen
 *      identifier-references die NIET in strings, comments, property-keys of
 *      member-expression-properties zitten. Elimineert false-positives van
 *      iteratie 1 (bv "Function" in doc-comment triggerde error).
 *   4. String-literal-scan voor image-URL-domeinen: elke `http(s)://...` in
 *      een string- of template-literal moet in `allowedImageDomains` staan,
 *      TENZIJ het een `{{image:role|query}}`-token is (die worden na
 *      validatie door de Design4-backend vervangen).
 *
 * Parse-fallback: als AST-parsen faalt (syntax error), degradeert de scan
 * naar tekst-scan zodat we nog steeds iets terugmelden. Dat is geen
 * kwaliteits-regressie omdat een niet-parseable Component.tsx sowieso niet
 * te bouwen is — Vite zou ook falen — dus de fallback fungeert alleen als
 * defense-in-depth.
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
// AST-walking helpers
// -----------------------------------------------------------------------------

type Node = TSESTree.Node;

function parseSource(source: string): TSESTree.Program | null {
  try {
    return parse(source, {
      // loc + range MOETEN true zijn — @typescript-eslint/parser v7.7.1
      // crasht anders met "Cannot read properties of undefined (reading '0')"
      // op typische TSX-input met imports + JSX-return. Kleine mem-overhead
      // maar functioneel vereist.
      loc: true,
      range: true,
      ecmaVersion: 'latest',
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
    }) as TSESTree.Program;
  } catch {
    return null;
  }
}

/**
 * Walk elke node in de AST. Volgorde is DFS pre-order.
 * Bewust minimaal (geen visitor-pattern lib) om extra deps te vermijden.
 */
function walk(node: Node | null | undefined, visit: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  if (!node || typeof node !== 'object') return;
  if ((node as { type?: string }).type) visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c === 'object' && (c as { type?: string }).type) {
          walk(c as Node, visit, node);
        }
      }
    } else if (child && typeof child === 'object' && (child as { type?: string }).type) {
      walk(child as Node, visit, node);
    }
  }
}

/**
 * Bepaalt of een Identifier-node een "reference" is naar een echte binding
 * (dus verwijzing naar een global of lokale variabele) — en NIET een
 * property-key, MemberExpression-property, ImportSpecifier-name, of
 * declaration-id.
 */
function isReference(identifier: Node, parent: Node | null): boolean {
  if (!parent) return true;
  const p = parent as Node & { type: string; computed?: boolean; key?: Node; property?: Node; id?: Node; imported?: Node; local?: Node; exported?: Node; params?: Node[]; name?: Node };

  switch (p.type as string) {
    // obj.foo — foo is property-name, geen reference naar global 'foo'
    case 'MemberExpression':
      if (p.property === identifier && !p.computed) return false;
      return true;

    // { foo: 1 } / { foo }
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
      // Shorthand-property `{ fetch }` IS een reference; alleen computed:false
      // met identifier ALLEEN als key skippen.
      if (p.key === identifier && !p.computed) {
        // Check shorthand: bij Property met shorthand=true is key === value
        const withShort = p as unknown as { shorthand?: boolean; value?: Node };
        if (withShort.shorthand) return true;
        return false;
      }
      return true;

    // import { fetch } from '...' → fetch is een geïmporteerde binding, niet global
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return false;

    // Declarations: var/let/const/function/class → binding declaration, geen ref
    case 'VariableDeclarator':
      if (p.id === identifier) return false;
      return true;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (p.id === identifier) return false;
      return true;

    // Function parameter names
    case 'AssignmentPattern':
    case 'RestElement':
    case 'ArrayPattern':
    case 'ObjectPattern':
      // Kan onderdeel zijn van param destructuring — skip als declaration
      return false;

    // Labels/type annotaties
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false;

    // TypeScript type-annotaties: identifiers hier zijn type-referenties, geen
    // runtime-globals (bv `let x: fetch` zou runtime-veilig zijn)
    case 'TSTypeReference':
    case 'TSQualifiedName':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
    case 'TSTypeParameter':
    case 'TSTypeAnnotation':
    case 'TSInterfaceHeritage':
    case 'TSExpressionWithTypeArguments':
      return false;

    // JSX
    case 'JSXAttribute':
      // <Foo bar={x} /> — bar is attribute-name, geen ref
      return false;
    case 'JSXOpeningElement':
    case 'JSXClosingElement':
      // <fetch /> — element-name is een JSX-component-referentie, ZOU een ref
      // moeten zijn. Maar in ons geval verwacht validator dat identifiers zoals
      // Fragment/Foo hier komen; forbidden-globals als JSX-element is de-facto
      // een gebruik ("fetch als component"). We tellen als reference.
      return true;

    default:
      return true;
  }
}

// -----------------------------------------------------------------------------
// Forbidden-globals (AST-based)
// -----------------------------------------------------------------------------

function validateForbiddenGlobals(
  componentTsx: string,
  ast: TSESTree.Program | null,
  issues: ValidationIssue[],
): void {
  const forbidden = new Set<string>(POLICY_V1_0.forbiddenGlobals);
  const found = new Set<string>();

  if (ast) {
    walk(ast, (node, parent) => {
      if (node.type !== 'Identifier') return;
      const idNode = node as TSESTree.Identifier;
      if (!forbidden.has(idNode.name)) return;
      if (!isReference(node, parent)) return;
      found.add(idNode.name);
    });
  } else {
    // Parse-fail fallback: naïeve tekst-scan zoals iteratie 1.
    const IDENT_BOUND = /[A-Za-z0-9_$]/;
    for (const g of forbidden) {
      let idx = componentTsx.indexOf(g);
      while (idx !== -1) {
        const before = idx > 0 ? componentTsx[idx - 1] : '';
        const after = idx + g.length < componentTsx.length ? componentTsx[idx + g.length] : '';
        if (!IDENT_BOUND.test(before ?? '') && !IDENT_BOUND.test(after ?? '')) {
          found.add(g);
          break;
        }
        idx = componentTsx.indexOf(g, idx + 1);
      }
    }
  }

  for (const g of found) {
    issues.push({
      severity: 'error',
      rule: 'policy.forbidden-global',
      message: `Component.tsx bevat referentie naar verboden global "${g}".`,
      location: { file: 'Component.tsx' },
    });
  }
}

// -----------------------------------------------------------------------------
// Image-URL domein-scan (string-literals + template-literals in de AST)
// -----------------------------------------------------------------------------

const URL_REGEX_ALL = /https?:\/\/([^\s"'`)]+)/g;

function extractStringsFromAst(ast: TSESTree.Program): string[] {
  const out: string[] = [];
  walk(ast, (node) => {
    if (node.type === 'Literal') {
      const v = (node as TSESTree.Literal).value;
      if (typeof v === 'string') out.push(v);
    } else if (node.type === 'TemplateLiteral') {
      const tl = node as TSESTree.TemplateLiteral;
      for (const q of tl.quasis) out.push(q.value.cooked ?? q.value.raw);
    }
  });
  return out;
}

function validateImageDomains(
  componentTsx: string,
  ast: TSESTree.Program | null,
  issues: ValidationIssue[],
): void {
  const allowed = POLICY_V1_0.allowedImageDomains;
  const strings = ast ? extractStringsFromAst(ast) : [componentTsx];
  const seenHosts = new Set<string>();

  for (const s of strings) {
    const matches = s.matchAll(URL_REGEX_ALL);
    for (const m of matches) {
      const urlPath = m[1] ?? '';
      const host = urlPath.split('/')[0] ?? '';
      if (seenHosts.has(host)) continue;
      seenHosts.add(host);
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
    const ast = parseSource(files.componentTsx);
    validateForbiddenGlobals(files.componentTsx, ast, issues);
    validateImageDomains(files.componentTsx, ast, issues);
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
