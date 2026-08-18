import { parse } from '@typescript-eslint/parser';
import type { TSESTree } from '@typescript-eslint/types';
import { z } from 'zod';

/**
 * validate-package — canonical AST-validator als HTTP-service.
 *
 * Waarom deze bestaat: sandbox-build-trigger (Deno Edge Function) MOET vóór
 * elke build/expose/PR een echte AST-scan draaien. Deno kan
 * @typescript-eslint/parser niet betrouwbaar trekken; Netlify Function (Node)
 * doet dat wel. Zonder een pass hier mag Deno geen executie toestaan.
 *
 * Bewuste architectuur-keuze: validator-code is inline gedupliceerd van
 * packages/studio4-sdk/src/validator.ts (SoT) omdat Netlify's esbuild-bundler
 * workspace .ts-exports niet altijd resolvet in cold-start. Bij wijziging in
 * de canonical → ook hier updaten. Beide worden vitest-gedekt.
 *
 * Security:
 *   - Bearer-auth met CANONICAL_VALIDATOR_SECRET env-var (server-to-server).
 *   - Zonder secret geconfigureerd → 500 (fail-safe, geen bypass).
 *   - Body-cap 512 KB.
 */

const MAX_BODY_BYTES = 512 * 1024;

// -----------------------------------------------------------------------------
// POLICY_V1_0 (inline kopie — sync met packages/studio4-sdk/src/policy-v1_0.ts)
// -----------------------------------------------------------------------------

const POLICY = {
  allowedImports: [
    'react',
    'react/jsx-runtime',
    'react-i18next',
    'lucide-react',
    '../../../lib/imageUtils',
    '../../../lib/sectionStyle',
    './types',
  ] as string[],
  forbiddenGlobals: [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'eval',
    'Function',
  ] as string[],
  allowedImageDomains: [
    'supabase.co',
    'tr2storage.blob.core.windows.net',
    'online.travelcompositor.com',
    'res.cloudinary.com',
    'static.travelconline.com',
    'i.travelapi.com',
  ] as string[],
};

// Minimale manifest-shape check via Zod
const KEBAB = /^[a-z][a-z0-9-]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

const AssetEntry = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  query: z.string().min(2).max(200),
  role: z.enum(['hero-bg', 'card', 'gallery', 'inline', 'background']).optional(),
}).strict();

const ManifestSchema = z.object({
  sdkVersion: z.literal('1.0'),
  id: z.string().regex(KEBAB),
  displayName: z.string().min(1),
  componentName: z.string().regex(PASCAL),
  fileName: z.string(),
  registryKey: z.string().regex(SNAKE),
  category: z.string().min(1),
  requestedImports: z.array(z.string()),
  assets: z.array(AssetEntry).max(20).optional(),
}).passthrough();

// -----------------------------------------------------------------------------
// AST-based forbidden-globals + image-URL scan (kopie van canonical validator)
// -----------------------------------------------------------------------------

type Node = TSESTree.Node;
type ValidationIssue = {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  location?: { file?: string };
};

function parseSource(source: string): TSESTree.Program | null {
  try {
    return parse(source, {
      loc: true,      // MUST — parser v7.7.1 crasht op TSX zonder loc+range
      range: true,
      ecmaVersion: 'latest',
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
    }) as TSESTree.Program;
  } catch {
    return null;
  }
}

function walk(node: Node | null | undefined, visit: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  if (!node || typeof node !== 'object') return;
  if ((node as { type?: string }).type) visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c === 'object' && (c as { type?: string }).type) walk(c as Node, visit, node);
      }
    } else if (child && typeof child === 'object' && (child as { type?: string }).type) {
      walk(child as Node, visit, node);
    }
  }
}

function isReference(identifier: Node, parent: Node | null): boolean {
  if (!parent) return true;
  const p = parent as Node & { type: string; computed?: boolean; key?: Node; property?: Node; id?: Node; shorthand?: boolean };
  switch (p.type as string) {
    case 'MemberExpression':
      if (p.property === identifier && !p.computed) return false;
      return true;
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
      if (p.key === identifier && !p.computed) return p.shorthand === true;
      return true;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return false;
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
    case 'AssignmentPattern':
    case 'RestElement':
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false;
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
    case 'JSXAttribute':
      return false;
    default:
      return true;
  }
}

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

function validatePackage(manifestJson: string, componentTsx: string): {
  ok: boolean;
  issues: ValidationIssue[];
  errorCount: number;
} {
  const issues: ValidationIssue[] = [];

  // 1. Manifest
  let manifest: z.infer<typeof ManifestSchema> | null = null;
  try {
    const raw = JSON.parse(manifestJson);
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) {
      for (const e of parsed.error.issues) {
        issues.push({
          severity: 'error',
          rule: `manifest.${e.code}`,
          message: `${e.path.join('.')}: ${e.message}`,
          location: { file: 'manifest.json' },
        });
      }
    } else {
      manifest = parsed.data;
      if (manifest.fileName !== `${manifest.componentName}.tsx`) {
        issues.push({
          severity: 'error',
          rule: 'manifest.fileName',
          message: `fileName moet '${manifest.componentName}.tsx' zijn`,
          location: { file: 'manifest.json' },
        });
      }
    }
  } catch (e) {
    issues.push({
      severity: 'error',
      rule: 'manifest.json-invalid-json',
      message: `manifest.json is geen valide JSON: ${(e as Error).message}`,
      location: { file: 'manifest.json' },
    });
  }

  // 2. Requested imports
  if (manifest) {
    const allowed = new Set(POLICY.allowedImports);
    for (const req of manifest.requestedImports) {
      if (!allowed.has(req)) {
        issues.push({
          severity: 'error',
          rule: 'policy.import-not-allowed',
          message: `Import "${req}" niet in POLICY_V1_0.allowedImports. Toegestaan: ${POLICY.allowedImports.join(', ')}`,
          location: { file: 'manifest.json' },
        });
      }
    }
  }

  // 3+4. Forbidden globals + image domains via AST
  const ast = parseSource(componentTsx);
  const forbidden = new Set(POLICY.forbiddenGlobals);
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
    // Parse-fail fallback: naïeve tekst-scan
    const IDENT = /[A-Za-z0-9_$]/;
    for (const g of forbidden) {
      let idx = componentTsx.indexOf(g);
      while (idx !== -1) {
        const before = idx > 0 ? componentTsx[idx - 1] : '';
        const after = idx + g.length < componentTsx.length ? componentTsx[idx + g.length] : '';
        if (!IDENT.test(before ?? '') && !IDENT.test(after ?? '')) {
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

  const strings = ast ? extractStringsFromAst(ast) : [componentTsx];
  const seenHosts = new Set<string>();
  for (const s of strings) {
    const matches = s.matchAll(URL_REGEX_ALL);
    for (const m of matches) {
      const host = (m[1] ?? '').split('/')[0] ?? '';
      if (seenHosts.has(host)) continue;
      seenHosts.add(host);
      const okDomain = POLICY.allowedImageDomains.some((d) => host === d || host.endsWith(`.${d}`));
      if (!okDomain) {
        issues.push({
          severity: 'error',
          rule: 'policy.image-domain-not-allowed',
          message: `URL naar "${host}" niet in POLICY_V1_0.allowedImageDomains.`,
          location: { file: 'Component.tsx' },
        });
      }
    }
  }

  // 5. Asset-manifest cross-check via AST — herken assets['key'] refs
  if (ast && manifest) {
    const declared = new Set<string>((manifest.assets ?? []).map((a) => a.key));
    const used = new Set<string>();
    walk(ast, (node) => {
      if (node.type !== 'MemberExpression') return;
      const me = node as TSESTree.MemberExpression;
      const obj = me.object as TSESTree.Node;
      if (obj.type !== 'Identifier' || (obj as TSESTree.Identifier).name !== 'assets') return;
      if (!me.computed) return;
      const prop = me.property as TSESTree.Node;
      if (prop.type === 'Literal' && typeof (prop as TSESTree.Literal).value === 'string') {
        used.add((prop as TSESTree.Literal).value as string);
      }
    });
    for (const k of used) {
      if (!declared.has(k)) {
        issues.push({
          severity: 'error',
          rule: 'policy.asset-key-not-declared',
          message: `Component gebruikt assets["${k}"] maar deze key staat niet in manifest.assets.`,
          location: { file: 'Component.tsx' },
        });
      }
    }
    for (const k of declared) {
      if (!used.has(k)) {
        issues.push({
          severity: 'warning',
          rule: 'policy.asset-key-unused',
          message: `manifest.assets bevat "${k}" maar Component gebruikt die niet.`,
          location: { file: 'manifest.json' },
        });
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return { ok: errorCount === 0, issues, errorCount };
}

// -----------------------------------------------------------------------------
// HTTP handler
// -----------------------------------------------------------------------------

export default async (req: Request): Promise<Response> => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const secret = process.env.CANONICAL_VALIDATOR_SECRET;
  if (!secret) {
    return new Response(
      JSON.stringify({ ok: false, error: 'server_secret_not_configured' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const authHeader = req.headers.get('authorization') ?? '';
  if (authHeader !== `Bearer ${secret}`) {
    return new Response(
      JSON.stringify({ ok: false, error: 'unauthorized' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const cl = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
    return new Response(
      JSON.stringify({ ok: false, error: 'body_too_large' }),
      { status: 413, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  let body: { manifestJson?: string; componentTsx?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_json_body' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  if (typeof body.manifestJson !== 'string' || typeof body.componentTsx !== 'string') {
    return new Response(
      JSON.stringify({ ok: false, error: 'missing_manifestJson_or_componentTsx' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const totalBytes = body.manifestJson.length + body.componentTsx.length;
  if (totalBytes > MAX_BODY_BYTES) {
    return new Response(
      JSON.stringify({ ok: false, error: 'payload_too_large' }),
      { status: 413, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const result = validatePackage(body.manifestJson, body.componentTsx);

  return new Response(
    JSON.stringify({
      ok: result.ok,
      issues: result.issues,
      errorCount: result.errorCount,
    }),
    { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
};

export const config = { path: '/api/validate-package' };
