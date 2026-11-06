// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  language: "en",
  additional: false,
  mode: "none",
  save: vi.fn(),
  load: vi.fn(),
  state: { settings: { dictationLanguageDialogOpen: false } },
}));
vi.mock("../../store", () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
  produceAppState: (fn: (state: typeof mocks.state) => void) => fn(mocks.state),
}));
vi.mock("../../utils/keyboard.utils", () => ({
  getAdditionalLanguageEntries: () => (mocks.additional ? [{}] : []),
}));
vi.mock("../../utils/user.utils", () => ({
  getMyUser: () => ({ preferredLanguage: mocks.language }),
  getDetectedSystemLocale: () => "en",
  getGenerativePrefs: () => ({ mode: mocks.mode }),
}));
vi.mock("../../actions/tone.actions", () => ({ loadTones: mocks.load }));
vi.mock("../../actions/user.actions", () => ({
  setPreferredLanguage: mocks.save,
}));
vi.mock("react-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-intl")>()),
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("../common/ListTile", () => ({
  ListTile: ({
    title,
    trailing,
    onClick,
  }: {
    title: ReactNode;
    trailing: ReactNode;
    onClick?: () => void;
  }) => (
    <div onClick={onClick}>
      {title}
      {trailing}
    </div>
  ),
}));
import { DictationLanguageSetting } from "./DictationLanguageSetting";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mocks.language = "en";
  mocks.additional = false;
  mocks.mode = "none";
  mocks.state.settings.dictationLanguageDialogOpen = false;
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.load.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = async () => {
  await act(async () =>
    root.render(
      <DictationLanguageSetting openPostProcessingDialog={vi.fn()} />,
    ),
  );
};

describe("DictationLanguageSetting", () => {
  it("shows the primary language selector and opens additional language settings", async () => {
    await render();
    expect(
      document.querySelector('[aria-label="Dictation language"]'),
    ).not.toBeNull();
    const moreButton = container.querySelector("button");
    expect(moreButton).not.toBeNull();
    await act(async () => moreButton?.click());
    expect(mocks.state.settings.dictationLanguageDialogOpen).toBe(true);
  });
  it("persists a changed primary language and reloads tones", async () => {
    await render();
    const select = document.querySelector('[role="combobox"]');
    expect(select).not.toBeNull();
    await act(async () =>
      select?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      ),
    );
    const option = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find((node) => node.textContent?.includes("Français"));
    expect(option).not.toBeUndefined();
    await act(async () =>
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith("fr");
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("shows the multiple-languages button instead of the selector", async () => {
    mocks.additional = true;
    await render();
    expect(container.textContent).toContain("Multiple languages");
    expect(
      document.querySelector('[aria-label="Dictation language"]'),
    ).toBeNull();
    await act(async () => container.querySelector("button")?.click());
    expect(mocks.state.settings.dictationLanguageDialogOpen).toBe(true);
  });
});
