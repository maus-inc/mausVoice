// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";
import { INTENT_DELAY_MS, useIntentWarmup } from "./intent-warmup.hooks";
ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
const warm = vi.fn(async () => {});
const Harness = ({ route = "a" }: { route?: string }) => (
  <button {...useIntentWarmup(warm, route)}>Destination</button>
);
beforeEach(() => {
  vi.useFakeTimers();
  warm.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
it("warms on sustained focus, but cancels a brief focus", async () => {
  const button = container.querySelector("button")!;
  act(() => {
    button.focus();
    button.blur();
  });
  await act(async () => vi.advanceTimersByTimeAsync(INTENT_DELAY_MS));
  expect(warm).not.toHaveBeenCalled();
  act(() => button.focus());
  await act(async () => vi.advanceTimersByTimeAsync(INTENT_DELAY_MS));
  expect(warm).toHaveBeenCalledOnce();
});
it("cancels intent on route change and unmount", async () => {
  act(() => container.querySelector("button")!.focus());
  act(() => root.render(<Harness route="b" />));
  await act(async () => vi.advanceTimersByTimeAsync(INTENT_DELAY_MS));
  expect(warm).not.toHaveBeenCalled();
  act(() => {
    container.querySelector("button")!.blur();
    container.querySelector("button")!.focus();
  });
  act(() => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(INTENT_DELAY_MS));
  expect(warm).not.toHaveBeenCalled();
});
it("ignores touch hover and cancels a brief pointer flyover", async () => {
  const button = container.querySelector("button")!;
  const dispatch = (type: string, pointerType: string) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    act(() => button.dispatchEvent(event));
  };
  dispatch("pointerover", "touch");
  await act(async () => vi.advanceTimersByTimeAsync(INTENT_DELAY_MS));
  expect(warm).not.toHaveBeenCalled();
  dispatch("pointerover", "mouse");
  dispatch("pointerout", "mouse");
  await act(async () => vi.advanceTimersByTimeAsync(INTENT_DELAY_MS));
  expect(warm).not.toHaveBeenCalled();
  dispatch("pointerover", "mouse");
  await act(async () => vi.advanceTimersByTimeAsync(INTENT_DELAY_MS));
  expect(warm).toHaveBeenCalledOnce();
});
it("contains speculative failure without an unhandled rejection", async () => {
  warm.mockRejectedValueOnce(new Error("offline"));
  act(() => container.querySelector("button")!.focus());
  await act(async () => vi.advanceTimersByTimeAsync(INTENT_DELAY_MS));
  expect(warm).toHaveBeenCalledOnce();
});
