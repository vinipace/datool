# Page titles and metadata

Every rendered page owns server metadata. Browser titles follow `Page · Datool`,
for example `Traces · Datool`, `Dataset details · Datool`, and `Sign in · Datool`.
The root layout owns the `Datool` fallback and the `%s · Datool` template through
`rootMetadata` in `lib/page-metadata.ts`. Leaf pages provide only the page name.

`pageTitles` is the shared catalog for metadata, sidebar labels, and workspace
headers. Use the same key for routes that render the same screen. Detail and
creation pages use their own keys instead of inheriting a collection's title.

## Adding a page

1. Add its name to `pageTitles` if no existing screen matches.
2. Export metadata from the server `page.tsx`:

```tsx
import { pageMetadata } from "@/lib/page-metadata"
import { DatasetsPage } from "@/components/tracer/datasets-page"

export const metadata = pageMetadata("datasets")

export default function Page() {
  return <DatasetsPage />
}
```

3. Keep hooks and interactivity in a client component. The server page owns
   metadata and any Suspense boundary; `app/(app)/sign-in/page.tsx` is an example.
4. Run `bun test tests/page-metadata.test.ts`, typecheck, and scoped ESLint.
   Confirm the browser title after both a direct load and a client navigation.

An alias re-exports both `default` and `metadata`, as `/sign-up` does for the
shared sign-in screen. Redirect-only pages use the destination's metadata and
are explicitly listed in the coverage test. If one starts rendering, remove it
from that list and give it metadata.

## Dynamic metadata

Use `generateMetadata` only when a title needs request or resource data. Start
with `pageMetadata(key)` for a descriptive fallback, then return the page title
without the brand suffix. Keep resource authorization in the server data owner
and share the authorized read with rendering using React `cache` when needed.
Do not fetch private resources independently just to construct a title.

The current detail pages use stable titles such as `Trace details`; their data
loads on the client. Metadata does not add a second resource request. Loading,
empty, and error states keep the page's descriptive title. Do not write
`document.title` in client effects or add another title template in a leaf page.

Next.js composes titles and the file-based favicon links. Keep favicon assets in
the root `app/` segment; a page title change does not need an `icons` override.
Route files use ESLint's Next.js Fast Refresh configuration to allow standard
framework exports such as `metadata` and `generateMetadata`.

## Social previews

The root `app/opengraph-image.png` is the shared 1200 × 630 social image.
`socialPreviewImage` in `lib/page-metadata.ts` supplies its path, dimensions,
MIME type, and alt text. Root metadata, CMS metadata, and docs metadata all reuse
it: a page that declares `openGraph` replaces that entire object and must
include the shared image. Twitter/X inherits the image and the page's title and
description; root metadata selects `summary_large_image`. `metadataBase` uses
the installation's `BETTER_AUTH_URL` so crawlers receive an absolute image URL.
When the build has no installation origin, static docs use `https://trydatool.com`
for the shared brand image instead of embedding a localhost URL.

Edit `assets/social-preview.html` and regenerate with
`node scripts/generate-social-image.mjs`. The renderer reuses the logo and dark
theme from `app/globals.css`, embeds Next.js's bundled Geist font, and exports
the PNG locally. It needs the Playwright Chromium browser installed;
image requests in production need no renderer, font fetch, or database access.
