// @vitest-environment jsdom
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const { request } = vi.hoisted(() => ({ request: vi.fn(() => null) }));
vi.mock("./keycap3d.worker-client", () => ({ requestCapRaster: request }));
import { usePrewarmDashboardKeycap } from "./keycap3d.prewarm";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState({}, "", "/dashboard");
  vi.useFakeTimers();
  request.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

it("defers warming until after mount and schedules once under StrictMode", async () => {
  const mounted = vi.fn();
  const Shell = () => {
    usePrewarmDashboardKeycap();
    useLayoutEffect(() => {
      mounted();
      expect(request).not.toHaveBeenCalled();
    }, []);
    return <span>Usable app</span>;
  };
  act(() =>
    root.render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    ),
  );
  expect(mounted).toHaveBeenCalled();
  expect(container.textContent).toBe("Usable app");
  expect(request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels scheduled warming when the shell unmounts", async () => {
  const Shell = () => {
    usePrewarmDashboardKeycap();
    return null;
  };
  act(() => root.render(<Shell />));
  expect(vi.getTimerCount()).toBe(1);
  act(() => root.render(null));
  await vi.runAllTimersAsync();
  expect(request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["/composer", "/composer/"])(
  "does not warm dashboard decoration at %s",
  async (path) => {
    window.history.replaceState({}, "", path);
    const Shell = () => {
      usePrewarmDashboardKeycap();
      return <span>Composer</span>;
    };
    act(() => root.render(<Shell />));
    expect(container.textContent).toBe("Composer");
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(request).not.toHaveBeenCalled();
  },
);
