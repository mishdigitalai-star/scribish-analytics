# Umami for scribish.ai, deployment notes

Self-hosted Umami, cookieless, first-party at https://analytics.scribish.ai.
Runs on infrastructure ScribisH already uses: Netlify (app) and the existing
ScribisH Supabase project (Postgres), with Umami's tables in their own
schema, `analytics`, isolated from the app's tables in `public`.

Only this file is ours; everything else is upstream umami-software/umami.
Upgrade with `git pull`. Umami ships its own netlify.toml (Next.js plugin
plus GeoIP data), so Netlify is a host the project supports directly.

## How the isolation works

- Umami reads `?schema=` from DATABASE_URL (scripts/check-db.js) and Prisma
  sets the search_path to it. Every CREATE TABLE in prisma/migrations is
  unqualified, so all ~25 Umami tables and Prisma's own `_prisma_migrations`
  land in `analytics`, nothing in `public`.
- No migration references `public.`, `auth.` or `storage.`; no foreign keys
  or views cross schemas (relationMode = "prisma", so no FK constraints at
  all). Umami has no RLS of its own and touches none of ScribisH's.
- The only extension statement is `CREATE EXTENSION IF NOT EXISTS pgcrypto`.
  Supabase already has pgcrypto installed (in the `extensions` schema), so
  it is a no-op. `gen_random_uuid()` is core Postgres anyway.
- The `analytics` schema is not exposed through the Supabase API (only
  `public` and `graphql_public` are), so the anon and service keys cannot
  read analytics tables, and Umami never sees ScribisH's.
- Umami connects with a dedicated `umami` database role that has rights on
  the `analytics` schema only, so even a bug in Umami cannot read or write
  ScribisH tables. See "Database setup" for the SQL.

## Database setup (run once in the Supabase SQL editor, after Michelle's yes)

    -- 1. Isolated schema and a role that can see only that schema.
    create schema if not exists analytics;
    create role umami login password '<choose a strong password>';
    grant usage, create on schema analytics to umami;
    alter role umami set search_path = analytics;
    revoke all on schema public from umami;

`umami` owns whatever it creates in `analytics`, has no grants on `public`,
and inherits nothing from `postgres` or the Supabase API roles.

## Netlify site (exists, linked from this folder)

    Site:  scribish-analytics, id aff798da-6a10-419a-aaa8-faf6c74ca546
    Admin: https://app.netlify.com/projects/scribish-analytics

Env vars already set: APP_SECRET (generated, secret, production context),
NODE_VERSION = 22.

Still to set, by the account owner (Site configuration > Environment
variables, mark both as secret):

    DATABASE_URL         Supabase "Transaction pooler" URI (port 6543), user
                         umami, with ?schema=analytics&pgbouncer=true&connection_limit=1
    DIRECT_DATABASE_URL  Supabase "Session pooler" URI (port 5432), user
                         umami, with ?schema=analytics

Two URLs because Netlify functions are serverless: runtime queries go
through the transaction pooler, and Prisma migrations (which need a session)
go through DIRECT_DATABASE_URL, which check-db.js already prefers. Use the
pooler hosts rather than the direct db.<ref>.supabase.co host, which is
IPv6-only.

## First deploy

Secret env vars are not readable by the Netlify CLI, so a local
`netlify deploy --build` will not see DATABASE_URL. Build on Netlify
instead: push this folder to a private GitHub repo and connect it to the
scribish-analytics site (same pattern as the scribish site). The first build
runs Prisma migrations against DIRECT_DATABASE_URL and creates the schema
contents.

Then:
1. Add custom domain analytics.scribish.ai in Netlify, add the CNAME it
   gives you in DNS. Netlify issues the certificate.
2. Sign in at https://analytics.scribish.ai (default admin / umami, change
   it immediately). Add website: name ScribisH, domain scribish.ai. Copy the
   Website ID.
3. On the scribish Netlify site set
     VITE_UMAMI_SCRIPT_URL = https://analytics.scribish.ai/script.js
     VITE_UMAMI_WEBSITE_ID = <the id>
   and redeploy scribish.ai. The tracker loads only when both are set
   (src/lib/analytics.js) and only reports from scribish.ai (data-domains).

## What the ScribisH site sends

- Pageviews per path, automatically, including in-app route changes.
  Referrer domain is recorded, so chatgpt.com, perplexity.ai, google.com
  separate out in the Referrers report with no extra work.
- `cta_click` with { page, cta } from every CTA on the five discovery pages.
- `signup` with { landing_page } from Signup.jsx on a successful sign-up,
  where landing_page is the first discovery page seen in that browser tab
  (sessionStorage, no cookie) or "direct".
