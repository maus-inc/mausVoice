# ProviderLogo · third-party marks (`provider-logo`)

- Status: **reused** — the real component and the real vendored artwork.
- Source of truth: `apps/desktop/src/components/common/provider-logos/ProviderLogo.tsx`, `ProviderLogos.tsx` (generated), `apps/desktop/src/assets/provider-logos/` (artwork + a provenance README).
- Used in: `ApiKeyList.tsx` (provider menu, edit caption, key card), `home/YourModelsCard.tsx`, `pages/AiModelsSettingsPage.tsx`, `PersonalApiKeyDialog.tsx`.

## Purpose

Say _which_ provider a setting or a key belongs to, using the provider's own mark.
The mark never replaces the provider's name, and it never encodes whether the
provider is local or remote — that is a security claim and it lives in prose.

## Artwork

Vendored SVG in `apps/desktop/src/assets/provider-logos/`, generated into
`ProviderLogos.tsx` by `pnpm --filter desktop run gen:provider-logos`. Never
hot-linked: the Tauri CSP allows `img-src 'self' asset: data: blob:` only, and a
remote fetch would tell a third party that settings were opened.

Three kinds of mark, one rule each:

| Kind            | Providers                                                               | Rule                                                         |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| Colour          | AssemblyAI, Azure, Cerebras, Claude, DeepSeek, Gemini, Groq, OpenRouter | drawn exactly as published, one file for both schemes        |
| Ink             | Deepgram, ElevenLabs, Ollama, OpenAI, xAI                               | `currentColor`, so the mark follows the surrounding text ink |
| Per-scheme pair | Gladia (navy / white), OpenRouter on onyx (`-mono`)                     | one file per surface                                         |

A mark is never recoloured, tinted with the app palette, put on a coloured chip,
outlined, rotated or stretched. Three providers — Aldea, Speaches, OpenAI
compatible — have no verifiable published mark and render nothing.

## Contrast

Colour marks clear the 3:1 floor for a non-text graphic on the surface they are
drawn on, measured by `ProviderLogo.test.tsx`:

| Mark       | Fill      | Cream `#FDFBF8` | Onyx `#161617`                  |
| ---------- | --------- | --------------- | ------------------------------- |
| Azure      | `#0089D6` | 3.66            | 4.78                            |
| Cerebras   | `#f15a29` | 3.26            | 5.37                            |
| Claude     | `#d97757` | 3.02            | 5.79                            |
| DeepSeek   | `#4d6bfe` | 4.19            | 4.18                            |
| Gemini     | `#3186FF` | 3.40            | 5.15                            |
| Groq       | `#F55036` | 3.34            | 5.24                            |
| OpenRouter | `#7624f4` | 6.11            | 2.87 → onyx uses the mono mark  |
| Gladia     | `#141A2A` | 16.79           | 1.04 → onyx uses the white mark |

## Sizes

16px in the provider menu and the disclosure sentence, 14px in a key card
caption, 20px on the overview card, 22px leading a settings row. House rule
(`.agents/skills/brand/references/logo-usage-rules.md`): 24px minimum for a mark
standing alone, so a mark is never the only thing labelling a control at these
sizes — the name is always beside it.

## Accessibility

`aria-hidden` wherever the provider's name is already rendered. `role="img"` plus
`aria-label` only where the mark is the sole identifier. The box is a
non-interactive `span`; a mark is never a button.

## Live-spec mapping

Size is patch-only: the value lives at each call site, not in the theme.
