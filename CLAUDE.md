# ahgiz-api — project instructions

## 🔒 MANDATORY SECURITY RULE — NEVER SKIP — NO EXCEPTIONS

Every new function added to the `public` schema in Supabase MUST include these
two lines at the end of its migration file, **without exception**:

```sql
REVOKE EXECUTE ON FUNCTION function_name(args) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION function_name(args) TO service_role;
```

(Use the exact argument type list, e.g. `soft_delete_user(uuid, uuid, text)`, to
target the correct overload.)

### Why this rule exists
Supabase grants `EXECUTE` to `PUBLIC` **by default on every new function**.
Without this explicit `REVOKE`, any new function is immediately accessible to
**unauthenticated users** via the public anon key (PostgREST `/rpc/...`) — a
**critical security vulnerability**. This is especially dangerous for
`SECURITY DEFINER` functions and any function that trusts a caller-supplied
actor id (`p_user_id`, `p_admin_id`, `p_customer_id`, …), which enables identity
spoofing (act as any user, approve payments as an admin, delete any account).

The `service_role` `GRANT` is required because `REVOKE ... FROM PUBLIC` also
removes `service_role`'s inherited execute — omitting it **breaks the live API**,
since every `.rpc()` call in this codebase runs through `supabaseAdmin`
(the service-role key). This actually happened on 2026-07-05.

### This rule is NON-NEGOTIABLE
Claude Code MUST apply it to **every** migration that creates a new function,
**even if the function seems harmless**. No exceptions. Both the mobile app and
this API call functions exclusively via the `service_role` key — no function
should ever be exposed to `anon` or `authenticated`.

### Belt-and-suspenders (one-time, run in Supabase SQL Editor)
A schema-wide default was set so future functions don't re-inherit the PUBLIC
grant. NOTE: `ALTER DEFAULT PRIVILEGES` is a **no-op over the Supabase connection
pooler (Supavisor)** — it must be run in the **Supabase Dashboard SQL Editor**:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
```

Even once this is in place, **still include the explicit per-function `REVOKE`/
`GRANT` in every migration** — do not rely on the default alone.

Full context and verification queries: `../ahgiz-backups/security_revoke_20260705.sql`.

---

## Migrations
- Migrations are applied **manually** by the user via the Supabase SQL Editor.
  Files live in `src/utils/migrations/`. A file existing does NOT mean it was applied.
- Every migration that creates a `public` function MUST end with the REVOKE/GRANT
  pair above (see the mandatory rule).

## Deploy
- Deploy via `railway up --service divine-creativity` (not GitHub auto-deploy).
