// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  hasBacklog: vi.fn(() => true),
  warning: vi.fn(),
}));
vi.mock("../../strategies/dictation.strategy", () => ({
  DictationStrategy: class {
    checkAndDrainBacklog = vi.fn<() => Promise<void>>();
  },
}));
vi.mock("../../utils/output-routing.utils", () => ({
  hasDictationBacklog: mocks.hasBacklog,
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: mocks.warning }),
}));
import { DictationStrategy } from "../../strategies/dictation.strategy";
import { useDictationBacklogDrain } from "./dictation-backlog.hooks";

const activeSessionRef = { current: () => true };

it("does not enqueue overlapping polls and allows a replacement strategy to run", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  let finishOld!: () => void;
  const old = new DictationStrategy();
  vi.mocked(old.checkAndDrainBacklog).mockReturnValue(
    new Promise<void>((resolve) => {
      finishOld = resolve;
    }),
  );
  const next = new DictationStrategy();
  vi.mocked(next.checkAndDrainBacklog).mockResolvedValue(undefined);
  const strategyRef = { current: old };
  const operationRef = { current: 1 };
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    useDictationBacklogDrain(
      true,
      true,
      strategyRef,
      operationRef,
      activeSessionRef,
    );
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(old.checkAndDrainBacklog).toHaveBeenCalledOnce();
    strategyRef.current = next;
    operationRef.current++;
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(next.checkAndDrainBacklog).toHaveBeenCalledOnce();
    finishOld();
    await act(async () => Promise.resolve());
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("allows the same strategy instance to drain a newer recording", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  let finish!: () => void;
  const strategy = new DictationStrategy();
  vi.mocked(strategy.checkAndDrainBacklog)
    .mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(undefined);
  const operationRef = { current: 1 };
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    useDictationBacklogDrain(
      true,
      true,
      { current: strategy },
      operationRef,
      activeSessionRef,
    );
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    operationRef.current++;
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(strategy.checkAndDrainBacklog).toHaveBeenCalledTimes(2);
    finish();
    await act(async () => root.unmount());
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("lets an already-started drain finish when only its polling effect ends", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  let ownsDrain!: () => boolean;
  let finish!: () => void;
  const strategy = new DictationStrategy();
  vi.mocked(strategy.checkAndDrainBacklog).mockImplementation((isCurrent) => {
    ownsDrain = isCurrent ?? (() => true);
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const strategyRef = { current: strategy };
  const operationRef = { current: 1 };
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    useDictationBacklogDrain(
      true,
      true,
      strategyRef,
      operationRef,
      activeSessionRef,
    );
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => root.unmount());
    expect(ownsDrain()).toBe(true);
    finish();
    await act(async () => Promise.resolve());
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("does not drain a retired auth session, including a queued probe", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  let current = true;
  const sessionRef = { current: () => current };
  const strategy = new DictationStrategy();
  vi.mocked(strategy.checkAndDrainBacklog).mockResolvedValue(undefined);
  const strategyRef = { current: strategy };
  const operationRef = { current: 1 };
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    useDictationBacklogDrain(true, true, strategyRef, operationRef, sessionRef);
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    vi.advanceTimersByTime(1_000);
    current = false;
    await act(async () => Promise.resolve());
    expect(strategy.checkAndDrainBacklog).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(strategy.checkAndDrainBacklog).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("does not dispatch an already-queued probe after ownership changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const old = new DictationStrategy();
  vi.mocked(old.checkAndDrainBacklog).mockResolvedValue(undefined);
  const next = new DictationStrategy();
  vi.mocked(next.checkAndDrainBacklog).mockResolvedValue(undefined);
  const strategyRef = { current: old };
  const operationRef = { current: 1 };
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    useDictationBacklogDrain(
      true,
      true,
      strategyRef,
      operationRef,
      activeSessionRef,
    );
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    vi.advanceTimersByTime(1_000);
    strategyRef.current = next;
    operationRef.current++;
    await act(async () => Promise.resolve());
    expect(old.checkAndDrainBacklog).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(next.checkAndDrainBacklog).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
