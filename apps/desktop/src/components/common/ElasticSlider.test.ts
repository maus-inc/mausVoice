import { describe, expect, it } from "vitest";
import { THUMB_CENTER_TRANSFORM, buildElasticSliderSx } from "./ElasticSlider";

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
