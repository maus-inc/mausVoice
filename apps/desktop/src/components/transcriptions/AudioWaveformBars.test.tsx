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
  const theme = {
    vars: { palette: { level1: "white", primary: { main: "blue" } } },
    palette: { background: { paper: "white" } },
    spacing: (value: number) => `${value}px`,
  };
  const result = styles
    .filter(
      (sx): sx is (input: typeof theme) => Record<string, unknown> =>
        typeof sx === "function",
    )
    .map((sx) => sx(theme))
    .find((sx) => sx.transform === "translateX(25%)");
  expect(result?.transition).toBe(`transform ${duration.fast}s linear`);
  expect(result?.[`@media ${reducedMotionQuery}`]).toEqual({
    transition: "none",
  });
});
