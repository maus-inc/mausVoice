import { describe, expect, it } from "vitest";
import { theme } from "../../theme";
import {
  THUMB_CENTER_TRANSFORM,
  buildElasticSliderSx,
  elasticSliderAccent,
} from "./ElasticSlider";

// MUI centers the horizontal thumb with `translate(-50%, -50%)`. The hover and
// active states scale the thumb about its center; if that centering translate
// is dropped, the thumb's top-left re-anchors on the track and it sinks
// down-right on hover/drag. These assertions pin the actual `sx` object the
// component renders, not a re-derived value.
type ThumbSx = {
  "& .MuiSlider-thumb": {
    "&:hover"?: { transform?: string };
    "&.Mui-active"?: { transform?: string };
  };
};

describe("ElasticSlider thumb centering", () => {
  const sx = buildElasticSliderSx("#166bbf", "#e8e7e4") as ThumbSx;
  const thumb = sx["& .MuiSlider-thumb"];

  it("re-composes the centering translate into the hover transform", () => {
    expect(thumb["&:hover"]?.transform).toBe(
      `${THUMB_CENTER_TRANSFORM} scale(1.15)`,
    );
  });

  it("re-composes the centering translate into the active (drag) transform", () => {
    expect(thumb["&.Mui-active"]?.transform).toBe(
      `${THUMB_CENTER_TRANSFORM} scale(1.25)`,
    );
  });

  it("never applies a vertical-only translation to the thumb", () => {
    const hover = thumb["&:hover"]?.transform ?? "";
    const active = thumb["&.Mui-active"]?.transform ?? "";
    expect(hover).toContain("translate(-50%, -50%)");
    expect(active).toContain("translate(-50%, -50%)");
    expect(hover).not.toMatch(/translateY\(/);
    expect(active).not.toMatch(/translateY\(/);
  });
});

describe("ElasticSlider thumb contrast", () => {
  it("draws the thumb ring with the chrome accent, not the white thumb colour", () => {
    // Asserted against the app's own theme, not MUI's default, because the
    // finding is specific to this palette: the thumb is `#FFFFFF` in both
    // schemes, and `primary.main` is white in dark mode too, so a `primary.main`
    // ring was white-on-white and the slider lost its silver accent.
    const schemes = theme.colorSchemes ?? {};
    for (const scheme of ["light", "dark"] as const) {
      const palette = schemes[scheme]?.palette;
      if (!palette) continue;
      const resolved = palette as unknown as {
        chrome: string;
        primary: { main: string };
      };
      expect(elasticSliderAccent({ palette: resolved })).toBe(resolved.chrome);
      // The thumb is hard-coded white, so the ring must never be white.
      expect(resolved.chrome.toLowerCase()).not.toBe("#ffffff");
      if (scheme === "dark") {
        // The premise of the finding: primary.main really is white in dark.
        expect(resolved.primary.main.toLowerCase()).toBe("#ffffff");
      }
    }
  });

  it("prefers the CSS-variable chrome value when the theme exposes vars", () => {
    expect(
      elasticSliderAccent({
        vars: { palette: { chrome: "var(--app-chrome)" } },
        palette: { chrome: "#fallback" },
      }),
    ).toBe("var(--app-chrome)");
  });
});
