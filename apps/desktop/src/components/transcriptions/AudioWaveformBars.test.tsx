import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { duration, reducedMotionQuery } from "../../styles/motion";

const styles = vi.hoisted(() => [] as unknown[]);
vi.mock("@mui/material", () => ({
  Box: ({ sx, children }: { sx: unknown; children?: React.ReactNode }) => {
    styles.push(sx);
    return createElement("div", null, children);
  },
}));
import { AudioWaveformBars } from "./AudioWaveformBars";

it("disables progress motion when reduced motion is requested", () => {
  styles.length = 0;
  renderToStaticMarkup(
    createElement(AudioWaveformBars, {
      values: [0.5],
      barWidth: 2,
      progressPercent: 25,
    }),
  );
  const progressStyle = styles[1] as (
    theme: unknown,
  ) => Record<string, unknown>;
  const result = progressStyle({
    vars: { palette: { level1: "white" } },
    palette: { background: { paper: "white" } },
  });
  expect(result.transition).toBe(`transform ${duration.fast}s linear`);
  expect(result[`@media ${reducedMotionQuery}`]).toEqual({
    transition: "none",
  });
});
