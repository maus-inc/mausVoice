// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({ save: vi.fn(), close: vi.fn() }));
vi.mock("../../actions/user.actions", () => ({
  setPreferredMicrophone: mocks.save,
}));
vi.mock("../../hooks/user.hooks", () => ({
  useMyPreferredMicrophone: () => savedPreference,
}));
vi.mock("../../store", () => ({
  useAppStore: (
    selector: (state: {
      settings: { microphoneDialogOpen: boolean };
    }) => unknown,
  ) => selector({ settings: { microphoneDialogOpen: open } }),
  produceAppState: (
    fn: (draft: { settings: { microphoneDialogOpen: boolean } }) => void,
  ) => {
    const draft = { settings: { microphoneDialogOpen: open } };
    fn(draft);
    open = draft.settings.microphoneDialogOpen;
    mocks.close();
  },
}));
vi.mock("react-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-intl")>()),
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
}));
vi.mock("../microphone/MicrophoneSelector", () => ({
  MicrophoneSelector: ({
    value,
    onChange,
    disabled,
  }: {
    value: string | null;
    onChange: (value: string | null) => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={() => onChange("usb")}>
      Current: {value ?? "automatic"}
    </button>
  ),
}));
vi.mock("../microphone/MicrophoneTester", () => ({
  MicrophoneTester: () => null,
}));
import { MicrophoneDialog } from "./MicrophoneDialog";

ensureUiHarness();
let open = true;
let savedPreference: string | null = null;
let container: HTMLDivElement;
let root: Root;
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(label),
  );
const render = async () =>
  act(async () => {
    root.render(<MicrophoneDialog />);
  });

beforeEach(() => {
  open = true;
  savedPreference = null;
  vi.clearAllMocks();
  mocks.save.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MicrophoneDialog", () => {
  it("saves a selection and shows success", async () => {
    await render();
    expect(button("Save changes")?.disabled).toBe(true);
    await act(async () => button("Current:")!.click());
    await act(async () => {
      button("Save changes")!.click();
      await Promise.resolve();
    });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith("usb");
    expect(document.body.textContent).toContain("Preference saved.");
  });

  it("allows retry after a failed save", async () => {
    mocks.save.mockRejectedValueOnce(new Error("offline"));
    await render();
    await act(async () => button("Current:")!.click());
    await act(async () => {
      button("Save changes")!.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Failed to save microphone preference",
    );
    await act(async () => {
      button("Save changes")!.click();
      await Promise.resolve();
    });
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Preference saved.");
  });

  it("does not report an earlier session's save after reopening", async () => {
    let finish: () => void = () => undefined;
    mocks.save.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(async () => button("Current:")!.click());
    await act(async () => button("Save changes")!.click());
    await act(async () => button("Close")!.click());
    await render();
    open = true;
    await render();
    expect(document.body.textContent).not.toContain("Preference saved.");
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("Preference saved.");
    expect(button("Current:")?.disabled).toBe(false);
  });

  it("starts only one save on rapid clicks before React commits", async () => {
    let finish: () => void = () => undefined;
    mocks.save.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(async () => button("Current:")!.click());
    const save = button("Save changes")!;
    await act(async () => {
      save.click();
      save.click();
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
  });
});
