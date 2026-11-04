// @vitest-environment jsdom
//
// A separate file from TipToast.test.tsx on purpose. That file mocks
// "sonner" at module scope (hoisted ahead of every test in it) to assert
// against the show/dismiss calls directly, which would hide the exact
// interaction this file exercises. The real sonner store decides what
// happens when a dismiss and a show for the same id land back to back.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@mui/material/styles";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { theme } from "../../theme";
import { SonnerToaster } from "../root/SonnerToaster";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

vi.mock("../../actions/onboarding.actions", () => ({
  dismissTip: vi.fn(),
}));

import { TipToastTrigger } from "./TipToast";

ensureUiHarness();
setMatchMedia(false);

let container: HTMLDivElement;
let root: Root;
/** jsdom does not run rAF; sonner's own dismiss debounce is driven explicitly. */
let pendingFrames: Array<FrameRequestCallback>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  pendingFrames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    pendingFrames.push(cb);
    return pendingFrames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    pendingFrames[handle - 1] = () => undefined;
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  // Drain while the stub is still installed, same reasoning as the
  // Settings test. Sonner's store is module-level and outlives this test.
  for (let round = 0; round < 5 && pendingFrames.length > 0; round += 1) {
    await act(() => {
      for (const frame of pendingFrames.splice(0)) frame(0);
    });
  }
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const drainFrames = async () => {
  await act(() => {
    for (const frame of pendingFrames.splice(0)) frame(0);
  });
};

const render = async (key: string) => {
  await act(() => {
    root.render(
      createElement(
        ThemeProvider,
        { theme },
        createElement(SonnerToaster, { key: "toaster" }),
        createElement(TipToastTrigger, {
          key,
          id: "assistant-mode",
          visible: true,
        }),
      ),
    );
  });
};

describe("TipToastTrigger remount under the same id", () => {
  it("keeps the toast on screen when a key change unmounts and remounts the trigger in one commit", async () => {
    // This is ChatsPage's actual pattern. ConversationLayout is keyed by
    // conversationId, so switching conversations unmounts the old
    // TipToastTrigger and mounts a new one under the same tip id
    // (assistant-mode) within a single React commit, not two separate
    // renders a tick apart.
    await render("conversation-a");
    // The toast's own mount transition is itself driven by a sonner
    // requestAnimationFrame, unrelated to the dismiss/remount race below.
    await drainFrames();
    expect(document.body.textContent).toContain("Talk to the assistant");

    await render("conversation-b");

    // The remount's show call races the old mount's dismiss call, which
    // sonner defers by a requestAnimationFrame. Nothing has run that frame
    // yet, so if the two calls fought instead of cooperating, the toast
    // would already be gone here.
    expect(document.body.textContent).toContain("Talk to the assistant");
    const toastEl = document.querySelector('[data-tip-toast="true"]');
    expect(toastEl).not.toBeNull();
    const sonnerToast = toastEl?.closest("[data-sonner-toast]");
    expect(sonnerToast?.getAttribute("data-removed")).toBe("false");

    // Draining the deferred frame is the real regression check. Sonner's
    // own create() cancels a same-tick pending dismissal for the id it is
    // about to reuse, so the old mount's dismiss must never reach the new
    // mount's toast even once that frame finally runs.
    await drainFrames();
    expect(document.body.textContent).toContain("Talk to the assistant");
    const toastAfterDrain = document.querySelector('[data-tip-toast="true"]');
    expect(toastAfterDrain).not.toBeNull();
    expect(
      toastAfterDrain
        ?.closest("[data-sonner-toast]")
        ?.getAttribute("data-removed"),
    ).toBe("false");
  });
});
