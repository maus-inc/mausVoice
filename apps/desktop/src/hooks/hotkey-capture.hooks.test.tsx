// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";
import { getAppState, setAppState, useAppStore } from "../store";
import {
  isHotkeyCaptureActive,
  useHotkeyCapture,
} from "./hotkey-capture.hooks";
import { useHotkeyFire } from "./hotkey.hooks";

ensureUiHarness();

function Capture({ active }: { active: boolean }) {
  useHotkeyCapture(active);
  return null;
}

it("keeps shortcuts disabled until every capture owner releases", () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const render = (first: boolean, second: boolean) =>
    act(() =>
      root.render(
        <StrictMode>
          <Capture active={first} />
          <Capture active={second} />
        </StrictMode>,
      ),
    );
  setAppState({ hotkeyCaptureOwnerIds: [] });
  try {
    render(true, false);
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    render(true, true);
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    render(false, true);
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    render(false, false);
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
    render(true, false);
  } finally {
    act(() => root.unmount());
  }
  expect(isHotkeyCaptureActive(getAppState())).toBe(false);
});

it("does not let an old cleanup release a new capture after state replacement", () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const render = (first: boolean, second: boolean) =>
    act(() =>
      root.render(
        <>
          <Capture active={first} />
          <Capture active={second} />
        </>,
      ),
    );
  setAppState({ hotkeyCaptureOwnerIds: [] });
  try {
    render(true, false);
    const observations: boolean[] = [];
    const unsubscribe = useAppStore.subscribe((state) => {
      observations.push(isHotkeyCaptureActive(state));
    });
    try {
      act(() => setAppState({ hotkeyCaptureOwnerIds: [] }));
      expect(isHotkeyCaptureActive(getAppState())).toBe(true);
      expect(observations).toEqual([true]);
    } finally {
      unsubscribe();
    }
    render(true, true);
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    render(false, true);
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
  } finally {
    act(() => root.unmount());
  }
  expect(isHotkeyCaptureActive(getAppState())).toBe(false);
});

it("ignores stale owner ids restored after their effects have cleaned up", () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  let staleIds: string[] = [];
  try {
    act(() => root.render(<Capture active />));
    staleIds = [...getAppState().hotkeyCaptureOwnerIds];
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    act(() => root.render(<Capture active={false} />));
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
    act(() => setAppState({ hotkeyCaptureOwnerIds: staleIds }));
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
  } finally {
    act(() => root.unmount());
    setAppState({ hotkeyCaptureOwnerIds: [] });
  }
});

it("remains disabled after a full replacement until both live effects finish", () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const render = (first: boolean, second: boolean) =>
    act(() =>
      root.render(
        <>
          <Capture active={first} />
          <Capture active={second} />
        </>,
      ),
    );
  try {
    render(true, true);
    act(() =>
      setAppState({ ...getAppState(), hotkeyCaptureOwnerIds: [] }, true),
    );
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    render(false, true);
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    render(false, false);
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
  } finally {
    act(() => root.unmount());
  }
});

it("suppresses actual bridge triggers across snapshot replacement and resumes after capture", () => {
  const root = createRoot(document.createElement("div"));
  const onFire = vi.fn();
  const Harness = ({ active }: { active: boolean }) => {
    useHotkeyCapture(active);
    useHotkeyFire({ actionName: "capture-test", onFire });
    return null;
  };
  try {
    act(() => root.render(<Harness active />));
    act(() =>
      setAppState(
        { ...getAppState(), hotkeyCaptureOwnerIds: [], hotkeyTriggers: {} },
        true,
      ),
    );
    act(() => setAppState({ hotkeyTriggers: { "capture-test": 1 } }));
    expect(onFire).not.toHaveBeenCalled();
    act(() => root.render(<Harness active={false} />));
    act(() => setAppState({ hotkeyTriggers: { "capture-test": 2 } }));
    expect(onFire).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    setAppState({ hotkeyCaptureOwnerIds: [], hotkeyTriggers: {} });
  }
});

it("does not leak a capture owner when registering it throws", () => {
  const root = createRoot(document.createElement("div"));
  const failure = new Error("store listener failed");
  const unsubscribe = useAppStore.subscribe(() => {
    throw failure;
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => act(() => root.render(<Capture active />))).toThrow(failure);
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
  } finally {
    unsubscribe();
    consoleError.mockRestore();
    act(() => root.unmount());
    setAppState({ hotkeyCaptureOwnerIds: [] });
  }
});
