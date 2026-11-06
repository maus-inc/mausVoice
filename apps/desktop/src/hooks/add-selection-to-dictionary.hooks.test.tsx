// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hotkey: null as null | (() => Promise<void>),
  invoke: vi.fn(),
  create: vi.fn(),
  flash: vi.fn(),
  terms: [] as string[],
  logger: { error: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../actions/dictionary.actions", () => ({
  createGlossaryTerms: mocks.create,
}));
vi.mock("../store", () => ({ getAppState: () => ({}) }));
vi.mock("../utils/app.utils", () => ({ collectTermValues: () => mocks.terms }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("../utils/overlay.utils", () => ({
  sendPillFlashMessage: mocks.flash,
}));
vi.mock("../utils/keyboard.utils", () => ({
  ADD_TO_DICTIONARY_HOTKEY: "add-to-dictionary",
}));
vi.mock("./hotkey.hooks", () => ({
  useHotkeyFire: ({ onFire }: { onFire: () => Promise<void> }) => {
    mocks.hotkey = onFire;
  },
}));
import { useAddSelectionToDictionary } from "./add-selection-to-dictionary.hooks";

const intl = createIntl({ locale: "en" });
intl.formatMessage = ((
  message: { defaultMessage?: string },
  values?: { text?: string },
) =>
  (message.defaultMessage ?? "").replace(
    "{text}",
    values?.text ?? "",
  )) as typeof intl.formatMessage;
const Probe = () => {
  useAddSelectionToDictionary({ isMainWindow: true, intl });
  return null;
};

describe("selection-to-dictionary hotkey", () => {
  let root: Root;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.terms = [];
    mocks.hotkey = null;
    mocks.invoke.mockResolvedValue("  Example ");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("serializes duplicate selections while the first write is pending", async () => {
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.create.mockImplementation(async (values: string[]) => {
      started();
      await pending;
      mocks.terms.push(...values);
      return { created: values, failed: 0 };
    });
    const first = mocks.hotkey!();
    await firstStarted;
    const second = mocks.hotkey!();
    release();
    await Promise.all([first, second]);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(["Example"]);
    expect(mocks.flash).toHaveBeenCalledWith(
      '"Example" is already in your dictionary',
    );
  });

  it("allows a later attempt when the first save fails", async () => {
    mocks.create
      .mockResolvedValueOnce({ created: [], failed: 1 })
      .mockResolvedValueOnce({ created: ["Example"], failed: 0 });
    await Promise.all([mocks.hotkey!(), mocks.hotkey!()]);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.flash).toHaveBeenCalledWith(
      "Could not add the selection to your dictionary. Please try again.",
    );
  });

  it("rejects a paragraph longer than 200 characters", async () => {
    mocks.invoke.mockResolvedValue("a".repeat(201));
    await mocks.hotkey!();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.flash).toHaveBeenCalledWith(
      "The selection is too long to add to the dictionary.",
    );
  });
});
