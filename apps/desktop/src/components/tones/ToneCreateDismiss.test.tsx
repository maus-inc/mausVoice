// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { theme } from "../../theme";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  setTarget: vi.fn(),
  cancel: vi.fn(),
  run: vi.fn(),
}));
vi.mock("react-intl", async (original) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(original);
});
vi.mock("../../actions/tone.actions", () => ({ upsertTone: mocks.upsert }));
vi.mock("../../actions/app-target.actions", () => ({
  setAppTargetTone: mocks.setTarget,
}));
vi.mock("./useTonePreview", () => ({
  useTonePreview: () => ({
    status: "idle",
    output: "",
    error: "",
    run: mocks.run,
    cancel: mocks.cancel,
  }),
}));
import { ToneCreateWizard } from "./ToneCreateWizard";
ensureUiHarness();
let host: HTMLDivElement;
let root: Root;
const close = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  setMatchMedia(false);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <ToneCreateWizard onClose={close} />
      </ThemeProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
const type = (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) => {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const name = () =>
  document.querySelector<HTMLInputElement>(
    'input[placeholder="Casual, Formal, Business..."]',
  )!;
const sendEscape = async (target: Element, composing = false) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: composing,
      }),
    );
  });

it("closes a pristine or cleared draft without confirmation", async () => {
  type(name(), "draft");
  type(name(), "");
  await act(async () => button("Cancel").click());
  expect(close).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain("Discard changes?");
});

it.each(["Cancel", "Escape", "backdrop"])(
  "protects a draft on %s and keeps it after cancelling",
  async (method) => {
    type(name(), "draft name");
    if (method === "Cancel") await act(async () => button("Cancel").click());
    else if (method === "Escape") await sendEscape(name());
    else {
      const backdrop = document.querySelector<HTMLElement>(
        ".MuiDialog-root .MuiBackdrop-root",
      )!;
      await act(async () => {
        backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        backdrop.click();
      });
    }
    expect(close).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Discard changes?");
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const confirm = dialogs[dialogs.length - 1];
    expect(document.activeElement).toBe(button("Cancel", confirm));
    await act(async () => button("Cancel", confirm).click());
    expect(name().value).toBe("draft name");
    expect(close).not.toHaveBeenCalled();
  },
);

it("does not close on a composing Escape", async () => {
  type(name(), "draft name");
  await sendEscape(name(), true);
  expect(close).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Discard changes?");
  expect(name().value).toBe("draft name");
});

it("discards only after confirmation finishes closing", async () => {
  type(name(), "draft name");
  await sendEscape(name());
  const dialogs = document.querySelectorAll('[role="dialog"]');
  const confirm = dialogs[dialogs.length - 1];
  await act(async () => {
    button("Discard", confirm).click();
    await new Promise((r) => setTimeout(r, 400));
  });
  expect(close).toHaveBeenCalledOnce();
});

it("does not dismiss, navigate, or duplicate a pending create", async () => {
  let resolve!: () => void;
  mocks.upsert.mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  type(name(), "draft");
  await act(async () => button("Next").click());
  type(document.querySelector<HTMLTextAreaElement>("textarea")!, "prompt");
  await act(async () => button("Next").click());
  const create = button("Create");
  await act(async () => {
    create.click();
    create.click();
  });
  expect(mocks.upsert).toHaveBeenCalledTimes(1);
  expect(create.getAttribute("aria-busy")).toBe("true");
  expect(
    create.querySelector('[role="progressbar"]')?.getAttribute("aria-label"),
  ).toBe("Working");
  expect(button("Cancel").disabled).toBe(true);
  expect(button("Back").disabled).toBe(true);
  await sendEscape(document.querySelector('[role="dialog"]')!);
  expect(close).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(close).toHaveBeenCalledOnce();
});
