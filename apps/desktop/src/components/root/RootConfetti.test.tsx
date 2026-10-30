// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("framer-motion", () => ({ useReducedMotion: () => motion.reduced }));
vi.mock("react-confetti", () => ({
  default: () => createElement("canvas", { "data-testid": "confetti" }),
}));

import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { RootConfetti } from "./RootConfetti";

ensureUiHarness();

describe("RootConfetti", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    setAppState(
      { ...structuredClone(INITIAL_APP_STATE), confettiCounter: 1 },
      true,
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    motion.reduced = false;
  });

  it("shows a celebration when motion is allowed", () => {
    act(() => root.render(createElement(RootConfetti)));
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("does not animate celebrations when reduced motion is requested", () => {
    motion.reduced = true;
    act(() => root.render(createElement(RootConfetti)));
    expect(container.querySelector("canvas")).toBeNull();
  });
});
