// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { useSettingsAnchor } from "./use-settings-anchor";

ensureUiHarness();
const clearQuery = () => {};
const Probe = ({
  available,
  kind,
}: {
  available: boolean;
  kind: "button" | "input" | "static";
}) => {
  const { requestFocus, focusSetting } = useSettingsAnchor(
    "",
    "dictation",
    available,
    clearQuery,
  );
  return (
    <>
      <button
        onClick={() => {
          requestFocus("example");
          focusSetting("example");
        }}
      >
        Result
      </button>
      <button>Other</button>
      {available &&
        (kind === "button" ? (
          <button id="setting-example">Target</button>
        ) : (
          <div id="setting-example">
            <span id="setting-example-label">Target</span>
            {kind === "input" && <input aria-label="Target" />}
          </div>
        ))}
    </>
  );
};
const flushFrame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
afterEach(() => vi.restoreAllMocks());

it.each(["button", "input", "static"] as const)(
  "moves search focus to the %s target",
  async (kind) => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Probe available kind={kind} />));
      const result = host.querySelector("button")!;
      result.focus();
      act(() => result.click());
      await flushFrame();
      const row = host.querySelector<HTMLElement>("#setting-example")!;
      expect(document.activeElement).toBe(
        kind === "input" ? row.querySelector("input") : row,
      );
      if (kind === "static")
        expect(row.getAttribute("aria-labelledby")).toBe(
          "setting-example-label",
        );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it("does not steal focus when a late target appears after another control was focused", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<Probe available={false} kind="input" />),
    );
    const [result, other] = host.querySelectorAll("button");
    result.focus();
    act(() => result.click());
    await flushFrame();
    other.focus();
    await act(async () => root.render(<Probe available kind="input" />));
    await flushFrame();
    expect(document.activeElement).toBe(other);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
