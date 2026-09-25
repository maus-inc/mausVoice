// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import de from "../../i18n/locales/de.json";

const { showErrorSnackbar, writeText } = vi.hoisted(() => ({
  showErrorSnackbar: vi.fn(),
  writeText: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../actions/app.actions", () => ({ showErrorSnackbar }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
vi.mock("framer-motion", () => ({
  useReducedMotion: () => true,
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    span: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  },
}));
import { CopyableCommand } from "./CopyableCommand";

ensureUiHarness();
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.useRealTimers();
});
const render = (command = "example command") =>
  act(() => {
    root?.render(
      <IntlProvider locale="de" messages={de}>
        <CopyableCommand command={command} />
      </IntlProvider>,
    );
  });
const button = () => container.querySelector("button")!;
const click = async () => {
  await act(async () => button().click());
};

it("waits for clipboard success, prevents duplicate writes, and expires feedback", async () => {
  let resolve!: () => void;
  writeText.mockReturnValue(new Promise<void>((done) => (resolve = done)));
  render();
  expect(button().getAttribute("aria-label")).toBe(de.copy);
  await click();
  expect(button().disabled).toBe(true);
  expect(container.querySelector(".lucide-check")).toBeNull();
  await click();
  expect(writeText).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  expect(button().disabled).toBe(false);
  expect(button().getAttribute("aria-label")).toBe(de.copied_successfully);
  expect(container.querySelector(".lucide-check")).not.toBeNull();
  act(() => vi.advanceTimersByTime(1800));
  expect(button().getAttribute("aria-label")).toBe(de.copy);
});

it("reports a localized failure without exposing the command and permits retry", async () => {
  writeText.mockRejectedValueOnce(new Error("secret command contents"));
  render("private command");
  await click();
  expect(showErrorSnackbar).toHaveBeenCalledWith(de.something_went_wrong);
  expect(container.querySelector(".lucide-check")).toBeNull();
  expect(button().disabled).toBe(false);
  await click();
  expect(writeText).toHaveBeenLastCalledWith("private command");
  expect(container.querySelector(".lucide-check")).not.toBeNull();
});

it("handles an unavailable clipboard as a recoverable failure", async () => {
  Object.defineProperty(navigator, "clipboard", { value: undefined });
  render();
  await click();
  expect(showErrorSnackbar).toHaveBeenCalledWith(de.something_went_wrong);
  expect(button().disabled).toBe(false);
});

it("ignores a previous command's late failure without blocking a new copy", async () => {
  let reject!: (reason: Error) => void;
  writeText.mockReturnValueOnce(
    new Promise<void>((_, fail) => (reject = fail)),
  );
  render("old");
  await click();
  render("new");
  await click();
  await act(async () => reject(new Error("old clipboard error")));
  expect(showErrorSnackbar).not.toHaveBeenCalled();
  expect(writeText).toHaveBeenLastCalledWith("new");
  expect(container.querySelector(".lucide-check")).not.toBeNull();
});

it("does not install a feedback timer after unmount", async () => {
  let resolve!: () => void;
  writeText.mockReturnValueOnce(new Promise<void>((done) => (resolve = done)));
  render();
  await click();
  act(() => root?.unmount());
  root = undefined;
  await act(async () => resolve());
  expect(vi.getTimerCount()).toBe(0);
  expect(showErrorSnackbar).not.toHaveBeenCalled();
});

it("clears an existing feedback timer on unmount", async () => {
  render();
  await click();
  act(() => root?.unmount());
  root = undefined;
  expect(vi.getTimerCount()).toBe(0);
});
