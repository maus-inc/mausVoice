import { Box, type BoxProps } from "@mui/material";
import type { ApiKeyProvider } from "@maus-inc/types";
import { useIsDarkMode } from "../../../hooks/color-scheme.hooks";
import { PROVIDER_LOGOS, type ProviderLogoId } from "./ProviderLogos";

/**
 * Which artwork identifies a provider, per scheme where one file cannot do both.
 *
 * `both` is used on either surface. `light` / `dark` override it where one
 * rendering of a mark sinks into one of the two surfaces. Two providers need
 * that, and neither may be recoloured to avoid it:
 *
 * - **OpenRouter** publishes a violet mark (`#7624f4`) that measures 2.87:1 on
 *   the onyx surface — under the 3:1 floor for a graphic — so the onyx surface
 *   gets the same silhouette in the text ink.
 * - **Gladia** publishes one markup in navy and one in white, which is exactly
 *   the positive/reversed pair a two-scheme app needs.
 *
 * Providers absent from this map have no published mark this project could
 * verify (see the asset README), so they render nothing rather than a stand-in
 * glyph: a generic icon beside a name only says "provider", and the name
 * already says which one. Nothing here ever encodes whether a provider is local
 * or remote — that is a security claim, and it lives in prose.
 */
const ARTWORK: Partial<
  Record<
    ApiKeyProvider,
    { both?: ProviderLogoId; light?: ProviderLogoId; dark?: ProviderLogoId }
  >
> = {
  assemblyai: { both: "assemblyai" },
  azure: { both: "azure" },
  cerebras: { both: "cerebras" },
  claude: { both: "claude" },
  deepgram: { both: "deepgram" },
  deepseek: { both: "deepseek" },
  elevenlabs: { both: "elevenlabs" },
  gemini: { both: "gemini" },
  gladia: { light: "gladia", dark: "gladia-dark" },
  groq: { both: "groq" },
  ollama: { both: "ollama" },
  openai: { both: "openai" },
  openrouter: { light: "openrouter", dark: "openrouter-mono" },
  xai: { both: "xai" },
};

/** Providers with artwork, so a caller can decide whether a mark will appear. */
export const hasProviderLogo = (provider: ApiKeyProvider): boolean =>
  ARTWORK[provider] != null;

export type ProviderLogoProps = Omit<BoxProps, "children"> & {
  /** The stored provider id, verbatim. Unknown ids render nothing. */
  provider: ApiKeyProvider;
  /** Square box the mark is fitted into, in CSS pixels. */
  size?: number;
  /**
   * The accessible name, for the rare slot where the mark is the only thing
   * naming the provider. Omit it wherever the provider's name is already on
   * screen: repeating it makes a screen reader say "Groq Groq".
   */
  label?: string;
};

/**
 * A provider's own mark, at the size the surface needs.
 *
 * Colour is the provider's decision, not ours: the artwork is used exactly as
 * published (see `src/assets/provider-logos/README.md`), so this component only
 * chooses *which* file to draw — the white sibling on the onyx surface for the
 * one mark that is dark-only, and nothing else. It never tints, inverts,
 * outlines or recolours, which is also why it is not a lucide glyph.
 *
 * The box is square and the SVG keeps its own `viewBox`, so a wider-than-tall
 * mark letterboxes inside the box instead of stretching.
 */
/**
 * The artwork file for a provider on a given surface, or `null` when the
 * provider has no verified mark.
 *
 * Resolving the file used to sit inline in the component as a two-level
 * optional chain, which read as one more branch in a render path that already
 * had several. Naming it keeps the component to the single decision it makes —
 * a mark or nothing — and puts the light/dark/both precedence in one place.
 */
const artworkFor = (
  provider: ApiKeyProvider,
  isDark: boolean,
): ProviderLogoId | null => {
  const art = ARTWORK[provider];
  if (!art) {
    return null;
  }
  const preferred = isDark ? art.dark : art.light;
  return preferred ?? art.both ?? null;
};

export const ProviderLogo = ({
  provider,
  size = 18,
  label,
  sx,
  ...rest
}: ProviderLogoProps) => {
  const isDark = useIsDarkMode();
  const artworkId = artworkFor(provider, isDark);
  if (!artworkId) {
    return null;
  }

  const Mark = PROVIDER_LOGOS[artworkId];

  return (
    <Box
      component="span"
      // A decorative mark is hidden from assistive tech outright rather than
      // left unlabelled, which some readers announce as an unnamed graphic.
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      sx={[
        {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          width: size,
          height: size,
          // An ink mark follows the text it sits beside; a colour mark ignores
          // `color` because its artwork carries its own fills.
          color: "text.primary",
          lineHeight: 0,
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...rest}
    >
      <Mark
        // The generator already sets `aria-hidden` and `focusable`. The SVG is
        // stretched to the tile through CSS rather than through an attribute:
        // `size` is not a DOM attribute React would pass through, and the
        // artwork keeps its own `viewBox`, so this cannot distort the mark.
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </Box>
  );
};
