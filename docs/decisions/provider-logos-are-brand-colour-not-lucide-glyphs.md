# Provider marks are the brands' own colour artwork, not recoloured lucide glyphs

Date: 2026-11-09
Status: accepted

## Context

The settings surface names providers in a dozen places — the API-key provider
select, the "Provider: …" caption on an edit card, the key card's caption, the
Overview's model rows, the two personal-key dialogs, and the disclosure sentence
that says where dictation audio goes — and every one of them was text only.
Nothing visually distinguished Groq from Deepgram, so the provider a row was
about had to be read, not seen.

`apps/desktop/DESIGN.md` says lucide (stroke 1.9) is the only icon family, so the
first pass drew each provider the way the app draws everything else: a monochrome
lucide-style glyph in `currentColor`, with the provider's initial as a fallback.
That was rejected. A hand-drawn approximation of someone else's trademark is both
a worse identifier than the real mark and a legal question nobody here is
qualified to answer; and an initial in a circle is the generic-icon pattern the
`antislop-ui` skill exists to refuse.

## Decision

Use each provider's **own published mark, in the colours it publishes**, at
identity size next to the provider's name.

Vendored artwork. The marks live in
`apps/desktop/src/assets/provider-logos/`, normalised to a transparent SVG with
an explicit `viewBox`, and generated into a single committed React module
(`ProviderLogos.tsx`) by `pnpm --filter desktop run gen:provider-logos`. The
Tauri CSP (`img-src 'self' asset: https://asset.localhost data: blob:`) forbids
hot-linking, and a remote fetch would also tell a third party that the user
opened settings — which contradicts the app's own privacy stance.

Three kinds of mark, one rule each:

| Kind | Providers | Rule |
| --- | --- | --- |
| Colour | AssemblyAI, Azure, Cerebras, Claude, DeepSeek, Gemini, Groq, OpenRouter | drawn exactly as published, one file for both schemes |
| Ink | Deepgram, ElevenLabs, Ollama, OpenAI, xAI | published as one colour only, so they are drawn in `currentColor` and follow the surrounding text ink |
| Per-scheme pair | Gladia (navy / white), OpenRouter on onyx | one file per surface, because one file cannot clear the contrast floor on both |

A mark is never recoloured, never tinted with the app palette, never inverted,
never placed on a coloured chip, outlined, rotated or stretched. The tile behind
it is a plain flex box of exactly the mark's size; the only scheme-dependent
decision is *which* file to draw.

Providers with no verifiable published mark — Aldea, Speaches, OpenAI
compatible — render **nothing**. No stand-in glyph, no initial: the provider's
name beside the slot is the identifier, and a generic icon there would only say
"provider", which the row already says.

Rejected:

- **Monochrome lucide-style glyphs for every provider.** It is a redraw of a
  trademark we do not own, it makes every provider look like the app's own icon
  set, and it throws away the one thing a brand mark is for.
- **Letter/initial fallbacks.** The generic-icon pattern; also unreadable at
  14–16px.
- **The `?react` svgr import the desktop app already has.** `apps/preview` has no
  svgr and imports the real desktop components, so `?react` would typecheck in
  the app and break the design site. A generated plain-React module works in
  both bundles with no per-app plugin and no `.d.ts` shim.
- **`@iconify-json/logos` wordmarks.** They are horizontal lockups (512×58 to
  512×266) and are unreadable as 16–22px identity marks.
- **A logo CDN.** Brandfetch's picker is hotlink-only with 24-hour URLs, which is
  both a CSP violation and a runtime dependency on a third party for a desktop
  app that must work offline.
- **Tinting a failing mark into the palette.** Recolouring a trademark to make it
  legible is exactly what the brand guidelines forbid; the answer is a different
  *published* rendering, which is what the per-scheme pairs are.

## Consequences

Each provider is now identifiable at a glance, and the identity is the brand's
own — no redraw, no approximation, no invented colour.

The cost is that colour is not ours to fix. A mark whose only published colour
sinks into one of the two surfaces has to fall back to the brand's own
mono/reversed rendering, so two providers carry a second file and the component
holds a small per-provider map. That map is the thing to check when a provider is
added: `ProviderLogo.test.tsx` pins the three providers that render nothing, and
measures every colour mark against the app's real surfaces (cream `#FDFBF8`,
onyx `#161617`) at the 3:1 floor for a non-text graphic.

Two further consequences worth naming:

1. The artwork is a **third-party asset set** with a licensing story. Provenance
   for every file, and the trademark notice, are in
   `apps/desktop/src/assets/provider-logos/README.md`. The drawings come from
   CC0 (`@iconify-json/logos`) and MIT (`@lobehub/icons-static-svg`) icon sets and
   one upstream repository (Gladia's own `gladiaflow`); the *marks* remain
   trademarks of their owners and this project claims no endorsement.
2. `DESIGN.md`'s "lucide is the only icon family" still governs chrome glyphs.
   This decision carves out **third-party identity only**: a mark identifies
   someone else's product, a glyph describes our own UI. The two never mix — a
   provider mark is never used as a control icon, and lucide is never used to
   stand in for a brand.
