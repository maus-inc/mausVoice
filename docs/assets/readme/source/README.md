# README hero sources

`../hero.png` is the published README hero (1200x380 PNG, rendered from
`hero-layout.svg`). All raster material comes from existing repository
assets; nothing was generated from scratch.

## Composition

- `hero-layout.svg` — deterministic layout: typography, divider, cursor
  arrow, placement of the two raster layers.
- `pill-still.png` — frame 6 of `../../animated-pill.gif` (extracted with
  `convert animated-pill.gif -coalesce`). This is the real recording pill
  with its sine-wave strings.
- `maus-icon.png` — referenced directly as `../../graphic.png` (the
  mausVoice app icon); no copy is kept here.

## Regenerating

From this directory, with sharp available (`npm i sharp`):

```bash
node -e "require('sharp')('hero-layout.svg').png().toFile('../hero.png')"
```

The layout uses Satoshi, TAN - PARADISO, and JetBrains Mono with DejaVu
fallbacks. Satoshi (`marketing/assets/fonts/Satoshi-Medium.ttf`) and
TAN - PARADISO (`marketing/assets/fonts/TAN-PARADISO-Regular.woff2`,
converted to TTF) ship with this repository; install them into your font
path before rendering for brand-exact output.
