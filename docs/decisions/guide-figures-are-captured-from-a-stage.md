# Guide figures are captured from a committed stage, not screenshotted by hand

Date: 2026-11-24
Status: accepted

## Context

The 0.1.6 documentation overhaul needed annotated visuals for the pill, the
review panel, the Home heatmap, and the assistant. Hand-taken screenshots carry
the author's window size, theme, and app state, cannot be re-verified, and go
stale the moment a token changes. The docs site also ships light and dark, so a
single screenshot is wrong for half the readers.

`apps/docs` had no image pipeline. There is no Playwright harness in this repo
(`docs/decisions/no-playwright-harness.md`), and the agent sandbox has Chromium
but no Playwright package.

## Decision

Commit a stage page and a capture script, and treat the PNGs as generated
artifacts.

- `apps/docs/scripts/figure-stage.html` holds every mock, one
  `[data-figure="<id>"]` section each, reading the same tokens from
  `apps/docs/src/styles/guides.css` that the docs pages use.
- `apps/docs/scripts/capture-guides.mjs` drives headless Chromium over the
  DevTools protocol with Node's built-in WebSocket, screenshots each element by
  its layout box at 2x, and writes `public/guides/<id>-{light,dark}.png`.
- `FigureImage.astro` renders both files and swaps them on `data-theme`, so the
  page follows the Starlight theme without JavaScript.
- Annotations are text in MDX (`Figure` and `Step` props), not baked into the
  image, so they stay selectable, searchable, and translatable.

Rejected: live CSS mocks rendered inside the MDX pages. They duplicated the
figure markup into the content, could not be embedded inside a step, and made
every page heavier than an image with a caption.

## Consequences

- A surface change is one command, `pnpm --filter docs figures`, plus a diff of
  the PNGs in the same PR.
- Badges attach to their target through `.mv-anchor` and `data-n`, so a marker
  cannot drift away from the control it describes.
- The PNGs are committed, about 55 KB each, well under the repository's 5 MB
  file limit.
- The stage file is HTML rather than Astro components. It is illustration
  markup, not product code, and it must be kept in step with the shipped
  surface by review. The docs pages never import it.
