// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { theme } from "../../theme";
import { ElasticSlider } from "./ElasticSlider";
ensureUiHarness();
setMatchMedia(true);

it("restores the saved value and live readout when a commit fails", async () => {
  const onCommit = vi.fn().mockRejectedValue(new Error("save failed"));
  const onDisplay = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <ThemeProvider theme={theme}>
          <ElasticSlider
            value={35}
            min={0}
            max={100}
            step={5}
            ariaLabel="Volume"
            onCommit={onCommit}
            onChangeDisplay={onDisplay}
          />
        </ThemeProvider>,
      ),
    );
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    await act(async () => {
      slider.focus();
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(onCommit).toHaveBeenCalledWith(40);
    expect(slider.value).toBe("35");
    expect(onDisplay).toHaveBeenLastCalledWith(35);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("does not drop a return to the saved value while the previous commit is pending", async () => {
  let finish!: () => void;
  const first = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: number[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const Harness = () => {
    const [saved, setSaved] = useState(35);
    const commit = async (value: number) => {
      calls.push(value);
      await first;
      setSaved(value);
    };
    return (
      <ThemeProvider theme={theme}>
        <ElasticSlider
          value={saved}
          min={0}
          max={100}
          step={5}
          ariaLabel="Volume"
          onCommit={commit}
        />
      </ThemeProvider>
    );
  };
  try {
    act(() => root.render(<Harness />));
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    act(() => {
      slider.focus();
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    act(() =>
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(calls).toEqual([40, 35]);
    await act(async () => {
      finish();
      await first;
    });
    expect(slider.value).toBe("35");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
