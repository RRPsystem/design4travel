/**
 * visual-compare — iteratie 4c.3
 *
 * Claude Sonnet 5 vision vergelijkt een sandbox-screenshot met de originele
 * reference-image. Returnt een match-score + concrete verschilpunten. Wordt
 * ná build_from_ai + expose aangeroepen (client maakt eerst een screenshot
 * via de bestaande capture-phase, of Claude fetcht de expose-URL live).
 *
 * Iteratie 4c.3-scope:
 *   - Client geeft `{ reference_path, screenshot_path }` (beide in Supabase Storage).
 *   - Edge Function signt beide, Claude vision krijgt ze als 2 image-blocks.
 *   - Tool `emit_visual_feedback` met scherpe schema.
 *   - Return: match_score (0-100), samenvatting, lijst differences met suggesties.
 *
 * Auto-repair-loop komt in Simple mode-iteratie: daar callt de orchestrator
 * op basis van deze feedback opnieuw generate-studio4-component met de
 * feedback als extra chat-prompt.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// -----------------------------------------------------------------------------
// Auth + signed URLs (kopie van sandbox-build-trigger patroon)
// -----------------------------------------------------------------------------

interface AuthResult { kind: 'user' | 'dev_bypass'; userId?: string; email?: string; }

async function verifyAuth(
  req: Request, supabaseUrl: string, serviceKey: string,
): Promise<AuthResult | { error: string; status: number }> {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return { error: 'missing_bearer_token', status: 401 };
  }
  const token = authHeader.slice(7).trim();
  if (!token) return { error: 'empty_bearer_token', status: 401 };
  if (token === serviceKey) return { kind: 'dev_bypass' };
  if (token.startsWith('sb_publishable_') || token.startsWith('sb_anon_')) {
    return { error: 'anon_key_not_accepted_use_user_jwt_or_service_role', status: 401 };
  }
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return { error: `auth_verify_${r.status}`, status: 401 };
  const user = (await r.json()) as { id?: string; email?: string };
  if (!user.id) return { error: 'auth_no_user_id', status: 401 };
  return { kind: 'user', userId: user.id, email: user.email };
}

async function signedDownloadUrl(
  supabaseUrl: string, serviceKey: string, bucket: string, path: string, expiresIn: number,
): Promise<string> {
  const r = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${path}`, {
    method: 'POST',
    headers: { apikey: serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  if (!r.ok) throw new Error(`sign_${r.status}: ${await r.text()}`);
  const j = await r.json() as { signedURL?: string; signedUrl?: string };
  const suffix = j.signedURL || j.signedUrl;
  if (!suffix) throw new Error('no_signedUrl_in_response');
  return `${supabaseUrl}/storage/v1${suffix}`;
}

// -----------------------------------------------------------------------------
// Prompts + tool
// -----------------------------------------------------------------------------

const COMPARE_SYSTEM_PROMPT = `Je bent een visuele design-vergelijker voor Design4 Travel.

Je krijgt twee beelden:
1. **Reference** — de originele design-inspiratie die de gebruiker aandroeg
2. **Rendered** — de door AI gegenereerde React-component zoals in de browser gerenderd

Beoordeel objectief hoe goed de rendered versie de essentie van de reference vertaalt. Geen letterlijke pixel-copy verwacht: het is een *interpretatie* voor een reissite met echte reisdata. Kijk vooral naar:

- **Layout-primitives**: hero met full-bleed image? Grid van cards? Split-hero? Sectie met achtergrondtypografie?
- **Kleurpalet**: warm/koel, saturatie, contrast tussen tekst en achtergrond
- **Typografische indruk**: display-grootte, hierarchie, sans/serif
- **Compositie-elementen**: cirkels/decoraties, overlays, cutouts, iconen
- **Sfeer**: matcht het gerenderde beeld het gevoel van de reference?

Geef één beoordeling via de tool \`emit_visual_feedback\`:

- **match_score** (0-100): hoe dicht de rendered versie bij de reference-essence komt.
  * 90+ = uitstekende vertaling
  * 70-89 = goede match, kleine punten
  * 40-69 = matig, wezenlijke verbeteringen mogelijk
  * <40 = compleet naast, moet opnieuw
- **summary** (Nederlands, 1-2 zinnen): overkoepelend oordeel
- **differences**: array met concrete verbeterpunten. Elke entry:
  * \`area\`: kort label ("kleurpalet", "titel-typografie", "layout")
  * \`severity\`: "minor" | "significant" | "critical"
  * \`suggestion\`: concrete instructie in gewone taal ("gebruik warmere aardetinten in plaats van neutrale grijzen", "vergroot de hero-titel tot ~7vw font-size", "voeg een grote semi-transparante achtergrondtekst toe")

Wees zuinig: geef alleen verbeterpunten die de essentie raken, niet elk pixel-verschil. Max 5 differences.`;

const COMPARE_TOOL = {
  name: 'emit_visual_feedback',
  description: 'Emit visuele vergelijking-feedback tussen reference en rendered.',
  input_schema: {
    type: 'object',
    properties: {
      match_score: { type: 'number', minimum: 0, maximum: 100 },
      summary: { type: 'string' },
      differences: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            area: { type: 'string' },
            severity: { type: 'string', enum: ['minor', 'significant', 'critical'] },
            suggestion: { type: 'string' },
          },
          required: ['area', 'severity', 'suggestion'],
        },
      },
    },
    required: ['match_score', 'summary', 'differences'],
  },
} as const;

// -----------------------------------------------------------------------------
// Anthropic call
// -----------------------------------------------------------------------------

interface VisualFeedback {
  match_score: number;
  summary: string;
  differences: Array<{ area: string; severity: 'minor' | 'significant' | 'critical'; suggestion: string }>;
}

async function callClaudeCompare(
  apiKey: string, referenceUrl: string, renderedUrl: string,
): Promise<{ feedback: VisualFeedback; tokensIn?: number; tokensOut?: number }> {
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 1500,
    system: COMPARE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'REFERENCE (originele design-inspiratie):' },
        { type: 'image', source: { type: 'url', url: referenceUrl } },
        { type: 'text', text: 'RENDERED (AI-gegenereerde versie zoals in browser):' },
        { type: 'image', source: { type: 'url', url: renderedUrl } },
        { type: 'text', text: 'Beoordeel en emit via de tool.' },
      ],
    }],
    tools: [COMPARE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_visual_feedback' },
  };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await r.json() as {
    content?: Array<{ type: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!r.ok || payload.error) {
    throw new Error(`anthropic_${r.status}: ${payload.error?.message ?? JSON.stringify(payload).slice(0, 400)}`);
  }
  const tool = payload.content?.find((b) => b.type === 'tool_use');
  if (!tool) throw new Error('no_tool_use_in_response');
  return {
    feedback: tool.input as VisualFeedback,
    tokensIn: payload.usage?.input_tokens,
    tokensOut: payload.usage?.output_tokens,
  };
}

// -----------------------------------------------------------------------------
// Deno.serve
// -----------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!anthropicKey || !supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: 'missing_env' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const auth = await verifyAuth(req, supabaseUrl, serviceKey);
  if ('error' in auth) {
    return new Response(
      JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  let body: { reference_path?: string; screenshot_path?: string } = {};
  try { body = await req.json(); } catch {
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_json_body' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
  if (!body.reference_path || !body.screenshot_path) {
    return new Response(
      JSON.stringify({ ok: false, error: 'reference_path_and_screenshot_path_required' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const t0 = Date.now();
  try {
    const refUrl = await signedDownloadUrl(supabaseUrl, serviceKey, 'design-references', body.reference_path, 600);
    const rendUrl = await signedDownloadUrl(supabaseUrl, serviceKey, 'sandbox-screenshots', body.screenshot_path, 600);
    const { feedback, tokensIn, tokensOut } = await callClaudeCompare(anthropicKey, refUrl, rendUrl);
    return new Response(JSON.stringify({
      ok: true,
      duration_ms: Date.now() - t0,
      feedback,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      duration_ms: Date.now() - t0,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
