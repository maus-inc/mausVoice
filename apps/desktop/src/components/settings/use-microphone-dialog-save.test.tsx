// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMicrophoneDialogSave } from "./use-microphone-dialog-save";

vi.mock("../../actions/user.actions", () => ({
  setPreferredMicrophone: vi.fn(() => Promise.resolve()),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

type Hook = ReturnType<typeof useMicrophoneDialogSave>;

let root: Root | null = null;
let container: HTMLDivElement;
let latest: Hook;

const Harness = ({
  open,
  savedPreference,
}: {
  open: boolean;
  savedPreference: string | null;
}) => {
  latest = useMicrophoneDialogSave({ open, savedPreference });
  return null;
};

const render = async (open: boolean, savedPreference: string | null) => {
  await act(() => {
    root!.render(
      createElement(
        IntlProvider,
        { locale: "en", messages: {} },
        createElement(Harness, { open, savedPreference }),
      ),
    );
  });
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  container.remove();
  root = null;
});

describe("the microphone dialog's draft", () => {
  it("keeps an unsaved choice when the saved preference refreshes", async () => {
    // The preference refreshes in the background -- another window saving, or an
    // onboarding write -- so the saved value can change while this dialog is open
    // with a choice in it. Replacing that choice discards what the user just
    // picked and disables Save, with nothing on screen to say why.
    await render(true, "Shure MV7");
    await act(() => latest.selectDevice("MacBook Pro Microphone"));
    expect(latest.selected).toBe("MacBook Pro Microphone");
    expect(latest.hasChanges).toBe(true);

    await render(true, "Jabra Evolve2 65");

    expect(latest.selected).toBe("MacBook Pro Microphone");
    expect(latest.hasChanges).toBe(true);
  });

  it("follows the saved preference while the draft is clean", async () => {
    // The other half: a value changed elsewhere has to reach a dialog with
    // nothing in it to lose.
    await render(true, "Shure MV7");
    expect(latest.hasChanges).toBe(false);

    await render(true, "Jabra Evolve2 65");

    expect(latest.selected).toBe("Jabra Evolve2 65");
  });

  it("resets the draft when the dialog reopens", async () => {
    await render(true, "Shure MV7");
    await act(() => latest.selectDevice("MacBook Pro Microphone"));

    await render(false, "Shure MV7");
    await render(true, "Shure MV7");

    expect(latest.selected).toBe("Shure MV7");
    expect(latest.hasChanges).toBe(false);
  });
});
