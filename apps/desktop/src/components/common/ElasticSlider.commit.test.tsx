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
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
  withLocalDataWrite,
} from "../../utils/local-data-write-gate";
import { ElasticSlider } from "./ElasticSlider";
ensureUiHarness();
setMatchMedia(true);

it("synchronizes the display callback on mount and saved-value changes", () => {
  const onDisplay = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (value: number) =>
    act(() =>
      root.render(
        <ThemeProvider theme={theme}>
          <ElasticSlider
            value={value}
            onCommit={() => {}}
            onChangeDisplay={onDisplay}
          />
        </ThemeProvider>,
      ),
    );
  try {
    render(35);
    expect(onDisplay).toHaveBeenLastCalledWith(35);
    render(45);
    expect(onDisplay).toHaveBeenLastCalledWith(45);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

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

/**
 * The shared rig for the gated-commit tests: one slider backed by local state,
 * a commit body supplied by the test, and keypress helpers. The tests differ
 * only in what their commit waits on.
 */
const createSliderHarness = (
  makeCommit: (
    setSaved: (value: number) => void,
  ) => (value: number) => void | Promise<void>,
) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const Harness = () => {
    const [saved, applySaved] = useState(35);
    const commit = makeCommit(applySaved);
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
  const render = () => act(() => root.render(<Harness />));
  const slider = () =>
    host.querySelector<HTMLInputElement>('input[type="range"]')!;
  const press = (key: string) =>
    act(() => {
      slider().focus();
      slider().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    });
  const cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { render, slider, press, cleanup };
};

it("does not drop a return to the saved value while the previous commit is pending", async () => {
  let finish!: () => void;
  const first = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: number[] = [];
  const harness = createSliderHarness((setSaved) => async (value) => {
    calls.push(value);
    await first;
    setSaved(value);
  });
  try {
    harness.render();
    harness.press("ArrowRight");
    harness.press("ArrowLeft");
    // 35 is queued behind the in-flight 40 commit rather than dropped or raced.
    expect(calls).toEqual([40]);
    await act(async () => {
      finish();
      await first;
    });
    await vi.waitFor(() => {
      expect(calls).toEqual([40, 35]);
      expect(harness.slider().value).toBe("35");
    });
  } finally {
    harness.cleanup();
  }
});

it("serializes overlapping commits and coalesces rapid queued steps so the latest value wins", async () => {
  let finishFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const calls: number[] = [];
  const harness = createSliderHarness((setSaved) => async (value) => {
    calls.push(value);
    if (calls.length === 1) {
      await firstGate;
    }
    setSaved(value);
  });
  try {
    harness.render();
    harness.press("ArrowRight");
    harness.press("ArrowRight");
    harness.press("ArrowRight");
    // 40 is running; 45 was coalesced into 50.
    expect(calls).toEqual([40]);
    await act(async () => {
      finishFirst();
      await firstGate;
    });
    await vi.waitFor(() => {
      expect(calls).toEqual([40, 50]);
      expect(harness.slider().value).toBe("50");
    });
  } finally {
    harness.cleanup();
  }
});

it("cancels a queued commit and releases its write lease immediately when a local-data clear starts", async () => {
  let finishFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const calls: number[] = [];
  const harness = createSliderHarness(
    (setSaved) => (value) =>
      withLocalDataWrite(async () => {
        calls.push(value);
        if (calls.length === 1) {
          await firstGate;
        }
        setSaved(value);
      }),
  );
  let releaseClear: (() => void) | undefined;
  try {
    harness.render();
    harness.press("ArrowRight");
    harness.press("ArrowRight");
    expect(calls).toEqual([40]);

    let clearPromise!: Promise<() => void>;
    act(() => {
      clearPromise = beginLocalDataClear();
    });
    await act(async () => {
      finishFirst();
      await firstGate;
      releaseClear = await clearPromise;
    });
    expect(calls).toEqual([40]);
  } finally {
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    releaseClear?.();
    harness.cleanup();
  }
});
