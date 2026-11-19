# Provider logos

Third-party brand marks, vendored so the app can show who a provider is without
fetching anything at runtime.

These are **trademarks of their owners**. mausVoice uses them to identify the
provider a setting belongs to; their presence here is not a claim of
endorsement, partnership or affiliation. Do not reuse this folder as a logo
pack.

## Why they are vendored

`apps/desktop/src-tauri/tauri.conf.json` sets
`img-src 'self' asset: https://asset.localhost data: blob:` and nothing else, so
a hot-linked logo is blocked in the packaged app. Hot-linking would also tell a
third party that the person opened a settings page — the app's own privacy
promise is that nothing leaves the machine until a provider is actually used.

Each mark is a small, hand-reviewed SVG. Nothing here is generated at build time
and nothing is fetched from a CDN.

## Files

`pnpm --filter desktop run gen:provider-logos` turns every file in this folder
into `src/components/common/provider-logos/ProviderLogos.tsx`. The generated
module is committed, and `ProviderLogo.test.tsx` fails if it has drifted from
these assets, so edit the SVG here and re-run the generator — never edit the
`.tsx`.

| File                  | Provider   | Artwork                                         | Colour                       |
| --------------------- | ---------- | ----------------------------------------------- | ---------------------------- |
| `assemblyai.svg`      | AssemblyAI | `assemblyai.svg`, `@lobehub/icons-static-svg`   | `currentColor`               |
| `azure.svg`           | Azure      | `azure-icon`, `@iconify-json/logos`             | `#0089D6`                    |
| `cerebras.svg`        | Cerebras   | `cerebras-icon`, `@iconify-json/logos`          | orange ring + `currentColor` |
| `claude.svg`          | Claude     | `claude-icon`, `@iconify-json/logos`            | coral `#d97757`              |
| `deepgram.svg`        | Deepgram   | `deepgram-icon`, `@iconify-json/logos`          | `currentColor`               |
| `deepseek.svg`        | DeepSeek   | `deepseek-icon`, `@iconify-json/logos`          | `#4d6bfe`                    |
| `elevenlabs.svg`      | ElevenLabs | `elevenlabs.svg`, `@lobehub/icons-static-svg`   | `currentColor`               |
| `gemini.svg`          | Gemini     | `gemini-color.svg`, `@lobehub/icons-static-svg` | blue gradient                |
| `gladia.svg`          | Gladia     | `gladia-icon.svg`, `gladiaio/gladiaflow`        | navy `#141A2A`, light only   |
| `gladia-dark.svg`     | Gladia     | as above                                        | white, onyx only             |
| `groq.svg`            | Groq       | `groq.svg`, `@lobehub/icons-static-svg`         | `#F55036`                    |
| `ollama.svg`          | Ollama     | `ollama`, `@iconify-json/logos`                 | `currentColor`               |
| `openai.svg`          | OpenAI     | `openai-icon`, `@iconify-json/logos`            | `currentColor`               |
| `openrouter.svg`      | OpenRouter | `openrouter-icon`, `@iconify-json/logos`        | `#7624f4`, light only        |
| `openrouter-mono.svg` | OpenRouter | `openrouter.svg`, `@lobehub/icons-static-svg`   | `currentColor`, onyx only    |
| `xai.svg`             | xAI (Grok) | `grok-icon`, `@iconify-json/logos`              | `currentColor`               |

Providers with no artwork here — **Aldea**, **Speaches** and **OpenAI
compatible** — have no published mark this project could verify. The
`ProviderLogo` component renders nothing for them rather than inventing one, and
the surfaces that use it keep the provider's name as the only identifier.

**Azure** is one stored provider id with two products behind it: the
transcription form calls it "Azure" (Speech-to-Text) and the post-processing
form calls it "Azure OpenAI". Both are Microsoft Azure services, so both draw
`azure.svg`; there is no separate Azure OpenAI mark to vendor.

## The colour rule

A mark is drawn in the colours its owner publishes it in. It is never
recoloured, never tinted with the app palette, never put on a coloured chip and
never given a gradient of our own.

That leaves three kinds of mark, and one rule each:

1. **Colour marks** (`azure`, `cerebras`, `claude`, `deepseek`, `gemini`,
   `groq`) carry their own fills and one file serves both schemes. Each clears
   the 3:1 contrast floor for a non-text graphic on both app surfaces.
2. **Ink marks** (`assemblyai`, `deepgram`, `elevenlabs`, `ollama`, `openai`,
   `xai`) are published as a single colour with no brand chrome. They are drawn
   in `currentColor` and inherit the surrounding text ink — near-black on cream,
   off-white on onyx — which is exactly the "positive / reversed" pair each of
   these brands publishes. AssemblyAI is here because its mark is published in
   black or white only: the indigo two-tone rendering that circulates is not the
   brand's colour, and it measured 2.47:1 on the onyx surface anyway.
3. **Per-scheme pairs** exist where the brand's only colour cannot clear the
   floor on one surface and the brand publishes an alternative:
   - **Gladia** publishes its mark on a navy tile. The tile is background, not
     mark, so it is dropped: `gladia.svg` is the mark in the tile's own navy for
     light surfaces, and `gladia-dark.svg` is the same mark in white for the
     onyx one. Both are transparent. Navy measures 16.79:1 on cream and 1.04:1
     on onyx, which is why the white rendering is not optional.
   - **OpenRouter** publishes one violet mark (`#7624f4`): 6.11:1 on cream,
     2.87:1 on onyx. The onyx surface gets the same silhouette in
     `currentColor`, which is the mono rendering the brand also publishes.

Measured on the app's own surfaces, not on pure black or white:

| Mark       | Fill      | Cream `#FDFBF8` | Onyx `#161617`   |
| ---------- | --------- | --------------- | ---------------- |
| Azure      | `#0089D6` | 3.66            | 4.78             |
| Cerebras   | `#f15a29` | 3.26            | 5.37             |
| Claude     | `#d97757` | 3.02            | 5.79             |
| DeepSeek   | `#4d6bfe` | 4.19            | 4.18             |
| Gemini     | `#3186FF` | 3.40            | 5.15             |
| Groq       | `#F55036` | 3.34            | 5.24             |
| OpenRouter | `#7624f4` | 6.11            | **2.87** → mono  |
| Gladia     | `#141A2A` | 16.79           | **1.04** → white |

`ProviderLogo.test.tsx` recomputes every one of these from the artwork, so a
re-export that dulls a fill fails the suite instead of shipping.

## Sizing and spacing

House rules (`.agents/skills/brand/references/logo-usage-rules.md`): minimum
24px for an icon-only mark, clear space equal to the mark's own height, no
stretch, crop, rotation, outline or shadow. In-app the mark sits at 14–22px
beside the provider's name, always aligned to that name's text box — the
component keeps the artwork's `viewBox` and sets one square size, so a wide mark
letterboxes inside its box instead of stretching. Because a mark at these sizes
is under the house minimum for a standalone icon, it is never the only thing
labelling a control.

The marks are **decorative** where the provider's name is already on screen
(`aria-hidden`), and labelled (`role="img"` + `aria-label`) where they are not.
They never stand alone as a control: a mark is not a button, and the surfaces
that offer an action put the provider's name on it.

## Provenance

Two icon sets and one upstream repository. Versions are the ones the artwork was
taken from on 2026-11-09.

- **`@iconify-json/logos` 1.2.19** (CC0-1.0) —
  <https://icon-sets.iconify.design/logos/>. The drawings are the `logos` icon
  set's; the set is a CC0 mirror of the simple-icons/`logos` lineage, and CC0
  covers the drawing, not the trademark it depicts.
- **`@lobehub/icons-static-svg`** (MIT) — <https://icons.lobehub.com/>. Used for
  `assemblyai`, `elevenlabs`, `gemini`, `groq` and the two mono siblings.
  Community-maintained, so each was checked against the brand's own published
  mark before use.
- **`gladiaio/gladiaflow`**, `public/icons/gladia-icon.svg` — Gladia's own
  artwork, fetched through the GitHub API. Used unmodified apart from dropping
  the tile behind it and re-inking the mark for each surface.

Every file in this folder is a transparent SVG with an explicit `viewBox` and no
`<title>`, `<style>`, `<script>`, `<image>` or external reference. Ids inside a
mark are namespaced by the generator, because SVG paint servers resolve by
document-wide id and two marks carrying `id="a"` would otherwise paint each
other.
