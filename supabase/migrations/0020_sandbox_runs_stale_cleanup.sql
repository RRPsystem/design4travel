-- =============================================================================
-- 0020_sandbox_runs_stale_cleanup.sql
--
-- E2B Hobby-sandboxes worden na 30 min timeout automatisch gekilld, maar
-- als de preview-host de destroy-call miste (tab-close, netwerkfout,
-- Netlify-redeploy), blijft de row in sandbox_runs op status='active'.
-- Rate-limit-check in sandbox-build-trigger telt die dan foutief mee →
-- 'rate_limit_concurrent_reached_5_5' zelfs als er geen echte sandbox
-- meer draait.
--
-- Deze migratie zet alle rijen die > 30 min geleden zijn aangemaakt en
-- nog op 'active' staan expliciet op 'destroyed'. Eenmalige cleanup;
-- toekomstige stale rows worden buiten deze migratie om afgevangen door
-- de aangescherpte rate-limit-check (alleen sandboxes < 30 min tellen).
-- =============================================================================

update public.sandbox_runs
set status = 'destroyed',
    destroyed_at = coalesce(destroyed_at, now())
where status = 'active'
  and created_at < now() - interval '30 minutes';

-- Optioneel voor toekomst: recurring cleanup via pg_cron zou de rate-limit-
-- code-side filter overbodig maken. Voor spike-fase blijft dit een eenmalige
-- catch-up en vertrouwen we op de code-side filter (zie sandbox-build-trigger
-- checkRateLimits).
