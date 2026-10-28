// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";
import { toLocalDateKey } from "../utils/date.utils";
import { useLocalToday } from "./use-local-today";

ensureUiHarness();

const TodayProbe = () => <span>{toLocalDateKey(useLocalToday())}</span>;

describe("useLocalToday", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("advances at local midnight and resynchronizes after the app regains focus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 8, 23, 59, 59, 500));

    await act(async () => {
      root.render(<TodayProbe />);
    });
    expect(container.textContent).toBe("2026-10-08");

    await act(async () => {
      vi.advanceTimersByTime(501);
    });
    expect(container.textContent).toBe("2026-10-09");

    vi.setSystemTime(new Date(2026, 9, 10, 12));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(container.textContent).toBe("2026-10-10");
  });
});
