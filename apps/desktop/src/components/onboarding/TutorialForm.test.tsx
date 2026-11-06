// @vitest-environment jsdom
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  finish: vi.fn(),
  confetti: vi.fn(),
  error: vi.fn(),
  clearLocalStorage: vi.fn(),
  setSelectedTone: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("../../actions/onboarding.actions", () => ({
  submitOnboarding: mocks.submit,
  finishOnboarding: mocks.finish,
}));
vi.mock("../../actions/app.actions", () => ({
  showConfetti: mocks.confetti,
  showErrorSnackbar: mocks.error,
}));
vi.mock("../../actions/local-storage.actions", () => ({
  clearLocalStorageValue: mocks.clearLocalStorage,
}));
vi.mock("../../actions/user.actions", () => ({
  setSelectedToneId: mocks.setSelectedTone,
}));
vi.mock("../../utils/analytics.utils", () => ({ trackButtonClick: vi.fn() }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("./OnboardingCommon", () => ({
  BackButton: () => null,
  OnboardingFormLayout: ({
    children,
    actions,
  }: {
    children: ReactNode;
    actions: ReactNode;
  }) => createElement("div", null, children, actions),
  DualPaneLayout: ({ left, right }: { left: ReactNode; right: ReactNode }) =>
    createElement("div", null, left, right),
}));
vi.mock("../common/DictationInstruction", () => ({
  DictationInstruction: () => null,
}));
vi.mock("../common/HotkeyBadge", () => ({ HotkeyBadge: () => null }));
vi.mock("./BouncyTooltip", () => ({ BouncyTooltip: () => null }));

import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import { theme } from "../../theme";
import { TutorialForm } from "./TutorialForm";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.submit.mockReset().mockResolvedValue({ id: "user" });
  mocks.finish.mockReset();
  mocks.setSelectedTone.mockReset().mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = async () => {
  await act(async () =>
    root.render(
      createElement(ThemeProvider, { theme }, createElement(TutorialForm)),
    ),
  );
};
const button = (label: string) => {
  const result = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((el) => el.textContent?.trim() === label);
  if (!result) throw new Error(`Missing ${label} button`);
  return result;
};

it("starts only one finish operation on a double Skip and permits retry after failure", async () => {
  let finish!: (value: null) => void;
  mocks.finish.mockReturnValueOnce(
    new Promise<null>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  const skip = button("Skip");
  await act(async () => {
    skip.click();
    skip.click();
  });
  expect(mocks.finish).toHaveBeenCalledTimes(1);
  await act(async () => finish(null));
  mocks.finish.mockResolvedValueOnce({ id: "user" });
  await act(async () => button("Skip").click());
  expect(mocks.finish).toHaveBeenCalledTimes(2);
  expect(mocks.confetti).toHaveBeenCalledTimes(1);
});

it.each(["resolve", "reject"] as const)(
  "does not report an old finish after auth changes when it %ss",
  async (outcome) => {
    let resolve!: (value: { id: string }) => void;
    let reject!: (error: Error) => void;
    mocks.finish.mockReturnValueOnce(
      new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      }),
    );
    await render();
    await act(async () => button("Skip").click());
    await act(async () => {
      setAppState({
        auth: {
          uid: "successor",
          email: null,
          displayName: null,
          providers: [],
        },
      });
      if (outcome === "resolve") resolve({ id: "old" });
      else reject(new Error("old finish failed"));
    });
    expect(mocks.confetti).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  },
);

it.each(["resolve", "reject"] as const)(
  "does not report an old finish to a replacement tutorial when it %ss",
  async (outcome) => {
    let resolve!: (value: { id: string }) => void;
    let reject!: (error: Error) => void;
    mocks.finish.mockReturnValueOnce(
      new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      }),
    );
    await render();
    await act(async () => button("Skip").click());
    await act(async () => root.render(null));
    await render();
    await act(async () => {
      if (outcome === "resolve") resolve({ id: "old" });
      else reject(new Error("old finish failed"));
    });
    expect(mocks.confetti).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  },
);

it("coalesces double Retry submissions and restores the override when successful", async () => {
  mocks.submit.mockResolvedValueOnce(null);
  let finish!: (value: { id: string }) => void;
  mocks.submit.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  const retry = button("Try again");
  await act(async () => {
    retry.click();
    retry.click();
  });
  expect(mocks.submit).toHaveBeenCalledTimes(2);
  await act(async () => finish({ id: "user" }));
  expect(getAppState().onboarding.dictationOverrideEnabled).toBe(true);
  expect(container.textContent).not.toContain("Something went wrong.");
});

it("waits for the initial onboarding submission under Strict Mode", async () => {
  let finish!: (value: null) => void;
  mocks.submit.mockReturnValueOnce(
    new Promise<null>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(ThemeProvider, { theme }, createElement(TutorialForm)),
      ),
    ),
  );
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(button("Skip").disabled).toBe(true);
  await act(async () => finish(null));
  expect(container.textContent).toContain("Something went wrong.");
  expect(button("Try again")).toBeDefined();
});

it("advances from notes to email, clears the draft, and finishes", async () => {
  mocks.finish.mockResolvedValueOnce({ id: "user" });
  await render();
  expect(button("Continue").disabled).toBe(true);
  const write = async (value: string) => {
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "textarea:not([aria-hidden])",
    );
    if (!textarea) throw new Error("missing tutorial field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await write("a note");
  await act(async () => button("Continue").click());
  expect(container.textContent).toContain("Now try an email");
  expect(button("Finish").disabled).toBe(true);
  await write("a message");
  await act(async () => button("Finish").click());
  expect(mocks.finish).toHaveBeenCalledTimes(1);
  expect(mocks.confetti).toHaveBeenCalledTimes(1);
});

it("does not publish an old tutorial submission after the auth identity changes", async () => {
  let finish!: (value: { id: string }) => void;
  mocks.submit.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await act(async () => {
    setAppState({
      auth: { uid: "successor", email: null, displayName: null, providers: [] },
    });
    finish({ id: "old" });
  });
  expect(getAppState().onboarding.dictationOverrideEnabled).toBe(false);
});

it("does not reset a successor session during old tutorial cleanup", async () => {
  await render();
  await act(async () => {
    setAppState((state) => ({
      auth: { uid: "successor", email: null, displayName: null, providers: [] },
      onboarding: { ...state.onboarding, dictationOverrideEnabled: true },
    }));
    root.render(null);
  });
  expect(getAppState().onboarding.dictationOverrideEnabled).toBe(true);
  expect(mocks.setSelectedTone).not.toHaveBeenCalled();
  expect(mocks.clearLocalStorage).not.toHaveBeenCalled();
});

it("does not clear a successor tutorial's checklist after a delayed tone reset", async () => {
  let finishTone!: () => void;
  mocks.setSelectedTone.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishTone = resolve;
    }),
  );
  await render();
  await act(async () => root.render(null));
  expect(mocks.setSelectedTone).toHaveBeenCalledOnce();
  const shouldUpdate = mocks.setSelectedTone.mock.calls[0][1] as () => boolean;
  expect(shouldUpdate()).toBe(true);
  await render();
  expect(shouldUpdate()).toBe(false);
  await act(async () => finishTone());
  expect(mocks.clearLocalStorage).not.toHaveBeenCalled();
});

it("does not restore dictation override after an in-flight initialization unmounts", async () => {
  let finish!: (value: { id: string }) => void;
  mocks.submit.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await act(async () => root.unmount());
  await act(async () => finish({ id: "user" }));
  expect(getAppState().onboarding.dictationOverrideEnabled).toBe(false);
});
