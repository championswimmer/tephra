# tephra-website

Marketing landing page for Tephra, built with [Astro](https://astro.build). Static output, no
client-side JavaScript.

This package is intentionally **not** part of the root npm workspaces — it has its own dependency
tree so the monorepo's `npm run check` is unaffected.

```bash
cd tephra-website
npm install
npm run dev      # http://localhost:4321
npm run build    # -> dist/
npm run preview
```

## Brand

Colors are taken directly from the Crystal Bloom logo (`docs/logos/crystal-bloom/logo.svg`) and
declared as custom properties in `src/styles/global.css`. The logo is vendored into `public/` as
`logo-main.svg` (plus `logo-main-light.png` / `logo-main-dark.png` for social cards). Re-copy those
files if the source logo changes.

## Structure

- `src/pages/index.astro` — the whole landing page (including Getting started) and its scoped styles
- `src/pages/deploy/[cloud].astro` — one short deploy page per cloud (`/deploy/railway/`, `/deploy/aws/`,
  `/deploy/gcp/`, `/deploy/digitalocean/`)
- `src/data/clouds.ts` — the steps and diagram labels for each cloud; keep in sync with `docs/deploy/*.md`
- `src/layouts/Base.astro` — html shell, meta tags, fonts
- `src/components/` — `Nav.astro`, `Footer.astro`, `diagram/` (hand-drawn SVG infra diagrams)
- `src/styles/global.css` — palette, typography, buttons, cards, light/dark themes
