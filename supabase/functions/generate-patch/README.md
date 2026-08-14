# generate-patch

Edge Function die een user-prompt + doc-snapshot omzet in een lijst
`PatchOp`-mutaties op een `project_documents.doc`. Router/specialist-patroon:

- **Orchestrator** (`claude-sonnet-5` default): entry-point. Handelt eenvoudige
  prop-tweaks en single-node-changes zelf af via de patch-tools
  (`set_prop`, `set_props`, `set_bind`, `reorder_children`, `insert_node`,
  `remove_node`, `set_brand_token`).
- **Specialist** (`claude-opus-5` default): wordt aangeroepen wanneer de
  orchestrator zelf besluit dat een verzoek complex/creatief/structureel is
  door het `delegate_to_opus`-tool te emit'en met een `enriched_prompt` en
  `rationale`. De Edge Function onderschept die delegatie en levert de
  Opus-response rechtstreeks terug — géén derde formatter-call.
- Beide calls loggen naar `public.ai_call_metrics` met een gedeelde
  `parent_call_id` zodat één gebruikersopdracht in twee rijen kan worden
  opgeteld voor toekomstige billing/dashboards.

Adaptive thinking staat aan op beide modellen (`thinking.type = adaptive`,
`output_config.effort = high` voor Sonnet, standaard `high` voor Opus en
`xhigh` op de delegate-pad). **Nooit** `budget_tokens` gebruiken op deze
modellen — de Anthropic API weigert dat vanaf Claude 4.7 met een 400.

## Deploy

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
# Optioneel — defaults zijn claude-sonnet-5 / claude-opus-5:
supabase secrets set ORCHESTRATOR_MODEL=claude-sonnet-5
supabase secrets set SPECIALIST_MODEL=claude-opus-5
# Optioneel — anthropic-beta header (bv. voor een specifieke feature-flag):
# supabase secrets set ANTHROPIC_BETA=some-beta-header

supabase db push --linked                              # migration 0013 (ai_call_metrics)
supabase functions deploy generate-patch --project-ref <dev>
```

## Request / response

```
POST /functions/v1/generate-patch
Authorization: Bearer <user JWT>
Content-Type: application/json

{
  "project_document_id": "uuid",
  "selected_node_id": "hero",    // optional
  "prompt": "maak de titel groter"
}

→ 200 OK
{
  "assistantMessage": "Hero-titel op 66px gezet.",
  "patches": [
    { "kind": "setProp", "nodeId": "hero", "key": "titleFontSize", "value": 66 }
  ]
}
```

## Error mapping

- 400 `invalid_request` / `invalid_json` — zod-fout op input.
- 401 `missing_authorization` / `invalid_user_token` — JWT ontbreekt of ongeldig.
- 404 `not_found` — `project_document_id` bestaat niet of user heeft geen RLS-toegang.
- 405 `method_not_allowed` — geen POST.
- 413 `payload_too_large` — body > 16 KB.
- 429 `rate_limited` — Anthropic rate-limit hit door.
- 500 `internal_error` — server-side config- of dep-fout (ontbrekende secret,
  onbekende Anthropic-fout, RPC-DB-fout).
- 502 `upstream_unavailable` / `upstream_error` — Anthropic 5xx / andere fout.

## Metrics

Elke call → één rij in `public.ai_call_metrics`. Delegate-pad = 2 rijen
gekoppeld via `parent_call_id`. Kolommen:

- `user_id`, `organization_id` — voor RLS + org-aggregation.
- `provider` (`'anthropic'`), `model`, `kind` (`router|specialist|standalone`).
- `parent_call_id` — self-FK naar de router-rij; `null` voor router/standalone.
- `route_reason` — de rationale-tekst uit `delegate_to_opus` (max 500 chars).
- `success` + `error_code` — voor foutmonitoring.
- `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
  `thinking_tokens` — voor cost-berekening.
- `latency_ms`, `request_id` — voor performance-monitoring en cross-ref.
- `provider_cost_microusd` — nullable in v1; wordt later ingevuld door een
  batch-job of view op basis van `pricing_version` × tokens.
- `pricing_version` — `'anthropic-2026-08'` (bump bij prijswijziging).

**Nooit opgeslagen**: prompt-tekst, response-tekst, JWT, API-key, doc-inhoud.
Fail-open: een insert-fout op `ai_call_metrics` mag de AI-response nooit
blokkeren — de Edge Function logt naar `console.error` en levert de response
alsnog.

## Dependencies

- `npm:@supabase/supabase-js@2.109.0` — auth verify + admin writes.
- `npm:zod@3.25.76` — request/response + PatchOp validation.

Anthropic wordt via `fetch` gebruikt (geen `@anthropic-ai/sdk`) omdat we
`output_config.effort` willen versturen zonder SDK-versie-lock-in.
