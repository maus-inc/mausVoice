import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { REGISTRY, type RegistryEntry } from "../lib/registry";
import { SpecProvider } from "../lib/spec-store";
import { SpecEditor } from "./spec-editor";

const entry: RegistryEntry = {
  id: "test-entry",
  name: "Test",
  category: "buttons",
  status: "reused",
  sources: [],
  usedIn: ["src/example.ts"],
  demo: "test",
  spec: [
    {
      key: "field",
      label: "Field",
      type: "text",
      default: "hello",
      target: { kind: "source", file: "src/example.ts" },
      mapsTo: "src/example.ts",
      patch: "const value = 1;",
    },
  ],
};
let container: HTMLDivElement;
let root: Root;
let clipboardDescriptor: PropertyDescriptor | undefined;
const button = (text: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  if (!found) throw new Error(`Missing ${text} button`);
  return found;
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (clipboardDescriptor)
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

it("keeps copied feedback visible for the full period after the latest copy", async () => {
  vi.useFakeTimers();
  act(() =>
    root.render(
      <SpecProvider>
        <SpecEditor entry={entry} />
      </SpecProvider>,
    ),
  );
  await act(async () => button("Patch").click());
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
    "const value = 1;",
  );
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => button("Copied").click());
  act(() => vi.advanceTimersByTime(500));
  expect(button("Copied")).toBeTruthy();
  act(() => vi.advanceTimersByTime(1000));
  expect(button("Patch")).toBeTruthy();
});

it("falls back to the legacy clipboard and removes its temporary field", async () => {
  const write = vi.mocked(navigator.clipboard.writeText);
  write.mockRejectedValue(new Error("clipboard denied"));
  const original = document.execCommand;
  const copy = vi.fn(() => true);
  document.execCommand = copy;
  try {
    act(() =>
      root.render(
        <SpecProvider>
          <SpecEditor entry={entry} />
        </SpecProvider>,
      ),
    );
    await act(async () => button("Patch").click());
    expect(copy).toHaveBeenCalledWith("copy");
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(button("Copied")).toBeTruthy();
  } finally {
    document.execCommand = original;
  }
});

it("does not show success if both clipboard methods fail", async () => {
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
    new Error("denied"),
  );
  const original = document.execCommand;
  document.execCommand = vi.fn(() => false);
  try {
    act(() =>
      root.render(
        <SpecProvider>
          <SpecEditor entry={entry} />
        </SpecProvider>,
      ),
    );
    await act(async () => button("Patch").click());
    expect(button("Patch")).toBeTruthy();
    expect(document.body.querySelector("textarea")).toBeNull();
  } finally {
    document.execCommand = original;
  }
});

it("ignores an earlier copy completing after a newer copy started", async () => {
  const write = vi.mocked(navigator.clipboard.writeText);
  let first!: () => void;
  let second!: () => void;
  write.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      first = resolve;
    }),
  );
  write.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      second = resolve;
    }),
  );
  act(() =>
    root.render(
      <SpecProvider>
        <SpecEditor entry={entry} />
      </SpecProvider>,
    ),
  );
  act(() => {
    button("Patch").click();
    button("Patch").click();
  });
  await act(async () => first());
  expect(button("Patch")).toBeTruthy();
  await act(async () => second());
  expect(button("Copied")).toBeTruthy();
});

it("shows an existing live numeric override and resets it to its spec default", () => {
  localStorage.setItem(
    "maus-preview-spec-overrides-v1",
    JSON.stringify({ button: { radius: 20 } }),
  );
  const buttonEntry = REGISTRY.find((item) => item.id === "button");
  if (!buttonEntry) throw new Error("Missing button registry entry");
  act(() =>
    root.render(
      <SpecProvider>
        <SpecEditor entry={buttonEntry} />
      </SpecProvider>,
    ),
  );
  const slider = container.querySelector<HTMLInputElement>(
    'input[aria-label="Corner radius"]',
  );
  expect(slider?.value).toBe("20");
  expect(container.textContent).toContain("edited");
  act(() => button("Reset").click());
  expect(slider?.value).toBe("12");
  expect(container.textContent).not.toContain("edited");
});

it("does not show copied feedback for an old patch after the selected entry changes", async () => {
  let finish!: () => void;
  vi.mocked(navigator.clipboard.writeText).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  act(() =>
    root.render(
      <SpecProvider>
        <SpecEditor entry={entry} />
      </SpecProvider>,
    ),
  );
  act(() => button("Patch").click());
  const replacement = {
    ...entry,
    id: "other-entry",
    spec: [{ ...entry.spec[0], patch: "const other = 2;" }],
  };
  act(() =>
    root.render(
      <SpecProvider>
        <SpecEditor entry={replacement} />
      </SpecProvider>,
    ),
  );
  await act(async () => finish());
  expect(button("Patch")).toBeTruthy();
});

it("retires an in-flight copy and clears feedback timers on unmount", async () => {
  vi.useFakeTimers();
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  const write = vi.mocked(navigator.clipboard.writeText);
  write.mockResolvedValueOnce(undefined);
  let finish!: () => void;
  write.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  act(() =>
    root.render(
      <SpecProvider>
        <SpecEditor entry={entry} />
      </SpecProvider>,
    ),
  );
  await act(async () => button("Patch").click());
  expect(button("Copied")).toBeTruthy();
  const feedbackIndex = setTimeoutSpy.mock.calls.findIndex(
    (call) => call[1] === 1500,
  );
  expect(feedbackIndex).toBeGreaterThanOrEqual(0);
  const feedbackTimer = setTimeoutSpy.mock.results[feedbackIndex].value;
  act(() => button("Copied").click());
  act(() => root.render(null));
  expect(clearTimeoutSpy).toHaveBeenCalledWith(feedbackTimer);
  await act(async () => finish());
  expect(
    setTimeoutSpy.mock.calls.filter((call) => call[1] === 1500),
  ).toHaveLength(1);
  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
});

it("does not run a stale clipboard fallback after a newer copy succeeds", async () => {
  let rejectFirst!: (reason: Error) => void;
  const write = vi.mocked(navigator.clipboard.writeText);
  write.mockReturnValueOnce(
    new Promise<void>((_, reject) => {
      rejectFirst = reject;
    }),
  );
  write.mockResolvedValueOnce(undefined);
  const original = document.execCommand;
  const fallback = vi.fn(() => true);
  document.execCommand = fallback;
  try {
    act(() =>
      root.render(
        <SpecProvider>
          <SpecEditor entry={entry} />
        </SpecProvider>,
      ),
    );
    act(() => button("Patch").click());
    await act(async () => button("Patch").click());
    await act(async () => rejectFirst(new Error("denied")));
    expect(button("Copied")).toBeTruthy();
    expect(fallback).not.toHaveBeenCalled();
  } finally {
    document.execCommand = original;
  }
});
