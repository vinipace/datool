# Marketing CMS

The CMS is disabled by default. Set `DATOOL_CMS_ENABLED=true` explicitly to enable
CMS routes, marketing pages, and release migrations. Existing CMS installations
must set this before upgrading. Application-only self-hosting needs no CMS setup.

The integration uses Payload 3.88, Postgres, Lexical, drafts and versions, reusable FAQ relationships, and an isolated `/cms` admin layout. Datool retains Better Auth for authentication.

## Content and routes

| Content                             | Payload model         | Public URL                   |
| ----------------------------------- | --------------------- | ---------------------------- |
| Landing page                        | `landing-page` global | `/`                          |
| FAQ introduction and SEO            | `faq-page` global     | `/faq`                       |
| Reusable questions and rich answers | `faqs` collection     | `/faq/[slug]` and FAQ blocks |
| Custom pages                        | `pages` collection    | `/pages/[slug]`              |

Pages support Hero, Features, Rich content, FAQ, and Call to action blocks. Custom slugs use lowercase words and hyphens. Signed-out visitors to `/` see the published landing page directly with HTTP 200 and no redirect. Signed-in visitors keep the existing active-organization/project redirect or organization picker, including `returnTo` handling. Protected application/API URLs retain their behavior; the product root layout now lives in `app/(app)/layout.tsx` so Payload can own its HTML and CSS independently. The `/` entry lives in `app/(home)` and shares the app theme without the workspace loading screen. It checks the server session per request and uses landing metadata for signed-out visitors. `/` is the landing page's canonical and Open Graph URL, appears in the sitemap, and is used by public home links. `/landing-page` remains an always-public alias with the same `/` canonical; `/landing-page.md` also declares `/` as its HTML canonical.

Each published FAQ has an answer page with breadcrumbs, an optional quick answer, the existing rich answer, individual SEO fields, and FAQPage structured data. On `/faq`, opening a question expands its full answer and related links inline while shallowly updating the URL to `/faq/[slug]`. Closing returns the URL to `/faq`; Back/Forward restore the expanded question without fetching a new page. Related-question links also expand in place. Direct visits, reloads, and new tabs still render the standalone answer page. Embedded FAQ blocks render the complete rich answer directly in the accordion, even when a quick answer is set. Existing rich answers remain compatible when no quick answer is set.

Connections follow `blog-2`: the read-only, virtual `relatedPages` field derives custom-page references from FAQ blocks. Public answer pages link back to published custom pages and the published landing page that include the question. Other published questions used on those same pages become related questions, deduplicated and excluding the current question. Removing a reference or unpublishing content updates those links automatically. A request-context guard prevents recursive reverse-relationship reads; public rendering resolves the relationships from access-checked published content.

Append `.md` to any public CMS URL to receive Markdown: `/landing-page.md`, `/pages/[slug].md`, `/faq.md`, and `/faq/[slug].md`. Responses serve Markdown as `text/plain; charset=utf-8` by default so it displays inline rather than downloading. Clients sending `Accept: text/markdown` receive the identical body with the Markdown media type. Responses preserve rich-text formatting and links, include complete FAQ answers, and identify the HTML canonical URL in the `Link` header. They use the same published-only queries as HTML, return 404 for missing/draft content, support HEAD, honor SEO no-index settings, and are not cached so publishing changes appear immediately. Rewrites map these URLs to `/api/cms-markdown/[...path]`; CMS/admin and application routes are not exported.

## Configuration and migration

Set `PAYLOAD_SECRET` to a stable random secret and `CMS_ADMIN_USER_IDS` to comma-separated **Better Auth user IDs**. An empty list denies all CMS editors. Sign-in uses the existing Google or magic-link configuration, verified-email policy, and `AUTH_ALLOWED_DOMAINS`. Allowlisted users are provisioned as editorial identities on their first authenticated CMS request; no public first-user or password registration is available. Customer roles never grant CMS access.

Payload owns only the `payload` Postgres schema. `PAYLOAD_DATABASE_URL` can point to a separate database; when omitted it uses `DATABASE_URL`. Existing application SQL migrations continue to own application tables. Automatic schema push is disabled.

After configuring the target database, run `bun run cms:migrate`. The Dokku release command uses `scripts/release.sh` to run application migrations followed by CMS migrations when `DATOOL_CMS_ENABLED=true`, before starting the new release and stopping on either failure. Compound commands must live in this script: Dokku passes inline shell operators such as `&&` as literal arguments. The runtime image includes the Payload configuration, CMS source, and migration files. Migrations are not run during the image build. The initial migration includes schema creation. Do not use reset/fresh migrations against existing data.

For a disposable local demo, use a loopback database named `datool_cms` or `datool_cms_*`, run application migrations for Better Auth, then:

```sh
bun run cms:migrate
bun run cms:seed
bun run dev
```

Without arguments, the seed refuses remote and ordinary app databases. This local demo creates nine FAQs, both globals, `/pages/how-it-works`, and an unpublished `/pages/draft-example`. Existing documents, drafts, editorial changes, identities, and publication dates are preserved on reruns. It does not create a login account.

### Production bootstrap

Set `DATOOL_CMS_ENABLED=true` and configure `PAYLOAD_SECRET` once with `openssl rand -hex 32`; keep it stable between releases. Set `CMS_ADMIN_USER_IDS` to the existing Better Auth account IDs that may edit content. `PAYLOAD_DATABASE_URL` can be omitted to reuse `DATABASE_URL`. Run migrations before opening `/cms`; otherwise authenticated requests fail because `payload.cms_users` does not exist.

Preview the missing starter content, then explicitly apply it to the named database:

```sh
sudo dokku run datool bun run cms:migrate
sudo dokku run datool bun run cms:seed --database datool_db
sudo dokku run datool bun run cms:seed --database datool_db --apply
```

`--database` must exactly match the configured database name. This mode previews by default and never includes the demo draft. `--apply` publishes only missing content: nine FAQs from `cms/seed-content.ts`, the landing and FAQ globals, and the linked How it works page. Existing records and saved drafts are preserved, including intentionally unpublished content. Seeding is a manual bootstrap step and is not repeated automatically during deployment.

For an existing landing page, seeding new FAQs makes them available in the CMS but preserves the page's current selection. Add the new questions to its FAQ block in **CMS → Landing page** and publish that change. New landing pages include all nine starter questions. The additional answers cover integration, trace details, trace-derived cases, scoring, prompt/model comparisons, and human review; they are grounded in the corresponding public guides under `content/docs/`.

The production image acceptance test runs the release migrations and seed twice, then verifies rendered homepage, FAQ, and Markdown content plus the CMS session API. `tests/cms-seed.integration.ts` additionally checks every CMS table before/after preview and reruns, including after unpublished editorial changes; run it with `node --import tsx tests/cms-seed.integration.ts` against a newly migrated, empty disposable CMS database.

## Editing and preview

Open `/cms`, sign in with your approved Datool Google account, and edit the globals or collections. Save Draft preserves the published version. Publish makes the saved content visible immediately; public routes read current published data on each request. Public Local API reads explicitly disable access overrides and drafts, and anonymous REST requests cannot read versions or mutate content.

Use Live Preview for landing/custom page blocks, individual FAQ answers, and the FAQ page introduction. `/cms-preview` requires an allowlisted editor session and starts with placeholder data; unsaved form changes arrive from Payload's preview channel. FAQ answer preview shows the unsaved question and answers; automatic connections are resolved on the public published page. The FAQ list itself is edited in the FAQs collection. Standalone saved-draft links, media uploads, blog content, and MCP editing are outside this integration.

## Development checks

```sh
bun run cms:generate:types
bun run cms:generate:importmap
bunx next typegen
bun run typecheck
bun run check:styles
bun test tests/cms-access.test.ts tests/cms-faq.test.ts tests/style-guard.test.ts
bun run test:cms
bun run test:cms:markdown
# With the seeded local dev server running:
bun run test:cms:http
bun run test:home:http
bun run build
```

`test:cms` uses the same disposable-local-database guard. It creates and removes its own fixtures, exercising publishing, draft isolation, reverse page references, related FAQ filtering, stable publication dates, and denied anonymous writes/version access. With a local `BETTER_AUTH_URL` or `CMS_TEST_URL`, it also checks fixture answer routes and draft-only FAQ 404s against the running server.

## Verification performed

Validated against an isolated `datool_cms_test` Postgres database: schema migrations, idempotent seed, collection access integration tests, and public HTTP checks. Browser verification covered the editor, unsaved live-preview changes, publishing and restoring content, responsive FAQ layout and keyboard focus, the empty FAQ state, and the database-outage error page. Individual FAQ verification covered index/embedded links, related-question and related-page navigation, a 390px layout, private unsaved FAQ previews, and publishing a disposable FAQ. Unit tests cover deduplication, unpublished relationships, isolated questions, and safe structured-data serialization. Draft/unknown custom pages and FAQs returned HTTP 404; a database outage returned HTTP 500. Authentication used temporary signed Better Auth test sessions, removed after verification; a real Google OAuth round trip still requires configured Google credentials.

### Product pages and public navigation

The marketing header links to Product, Pricing, Docs, and FAQ. Product has exactly
four destinations: Build, Observe, Evaluate, and Discover. The pillar and feature
catalog is `lib/marketing/product.ts`; editable starter copy is
`cms/product-content.ts`. The missing-only seed creates `product-build`,
`product-observe`, `product-evaluate`, and `product-discover` records in Pages.
Existing published pages and editorial drafts are preserved on every rerun.

Each pillar is served at `/product/<pillar>` with matching canonical metadata and
Markdown output. `/product` redirects to Build. Legacy feature URLs redirect to
stable section anchors on the appropriate pillar page; they are excluded from
the sitemap. Legacy CMS records are retained for editorial history. Unknown or
unpublished pillars return 404. Edit copy and SEO in Payload's Pages collection.
The block names identify each feature's introduction, capabilities, and example;
keep these stable so the specialized page renderer can pair those blocks.

Pricing reuses the Core/Pro catalog and Stripe price reader from the Cloud
billing implementation (`5092cde`). Both plans include all features; allowances
and retention differ. Prices are read from the configured active monthly USD
Stripe prices. Local installations without Cloud billing display the plan
allowances and an unavailable-pricing notice instead of fabricated amounts.
This change does not enable billing, create subscriptions, or add checkout.
