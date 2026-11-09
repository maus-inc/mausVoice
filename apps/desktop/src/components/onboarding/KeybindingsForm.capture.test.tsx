// @vitest-environment jsdom
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  sync: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.error,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({ saveHotkey: mocks.save }),
}));
vi.mock("../../utils/keyboard.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/keyboard.utils")>()),
  syncHotkeyCombosToNative: mocks.sync,
}));
vi.mock("../../utils/analytics.utils", () => ({ trackButtonClick: vi.fn() }));
vi.mock("../../actions/onboarding.actions", () => ({
  goToOnboardingPage: vi.fn(),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("./OnboardingCommon", () => ({
  BackButton: () => null,
  DualPaneLayout: ({ left, right }: { left: ReactNode; right: ReactNode }) =>
    createElement("div", null, left, right),
  OnboardingFormLayout: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("../common/KeyPressSimulator", () => ({
  KeyPressSimulator: () => null,
}));
vi.mock("../common/HotkeyBadge", () => ({ HotkeyBadge: () => null }));
vi.mock("../common/HotKey", () => ({
  HotKey: ({ onChange }: { onChange: (keys: string[]) => void }) =>
    createElement("button", { onClick: () => onChange(["KeyB"]) }, "Set B"),
}));
import { KeybindingsForm } from "./KeybindingsForm";
import { HotkeySetting } from "../settings/HotkeySetting";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
const held = (keys: string[]) =>
  act(() =>
    produceAppState((draft) => {
      draft.keysHeld = keys;
    }),
  );
const start = () => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === "Change hotkey",
  );
  if (!button) throw new Error("Change hotkey button not found");
  act(() => button.click());
};
beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.sync.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(KeybindingsForm),
      ),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("saves the complete chord once on release, not intermediate keys", async () => {
  start();
  held(["ControlLeft"]);
  held(["ControlLeft", "KeyK"]);
  expect(mocks.save).not.toHaveBeenCalled();
  held(["ControlLeft"]);
  await act(async () => {});
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save.mock.calls[0][0].keys).toEqual(["ControlLeft", "KeyK"]);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("releases the recording guard when unmounted during capture", () => {
  start();
  expect(getAppState().isRecordingHotkey).toBe(true);
  act(() => root.unmount());
  expect(getAppState().isRecordingHotkey).toBe(false);
  root = createRoot(container);
});

it("cancels without saving when focus leaves during capture", () => {
  start();
  held(["KeyK"]);
  const panel = container.querySelector<HTMLElement>('[tabindex="0"]')!;
  act(() => panel.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.save).not.toHaveBeenCalled();
  expect(getAppState().isRecordingHotkey).toBe(false);
});

it("serializes successive recordings and keeps their persistent identity", async () => {
  let finishFirst!: () => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  start();
  held(["KeyA"]);
  held([]);
  await act(async () => {});
  start();
  held(["KeyB"]);
  held([]);
  await act(async () => {});
  expect(mocks.save).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishFirst();
  });
  expect(mocks.save).toHaveBeenCalledTimes(2);
  const [first, second] = mocks.save.mock.calls.map(([hotkey]) => hotkey);
  expect(first.keys).toEqual(["KeyA"]);
  expect(second.keys).toEqual(["KeyB"]);
  expect(second.id).toBe(first.id);
  // The form's explicit sync runs after the last queued persistence result.
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("rejects modifier-only recordings for the bridge strategy", async () => {
  act(() =>
    produceAppState((draft) => {
      draft.hotkeyStrategy = "bridge";
    }),
  );
  start();
  held(["ShiftLeft"]);
  held([]);
  await act(async () => {});
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith(
    expect.stringContaining("non-modifier"),
  );
  expect(getAppState().isRecordingHotkey).toBe(false);
});

it("cancels Escape without saving a shortcut", async () => {
  start();
  held(["Escape"]);
  held([]);
  await act(async () => {});
  expect(mocks.save).not.toHaveBeenCalled();
  expect(getAppState().isRecordingHotkey).toBe(false);
});

it("continues the save queue after a failed write", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.save.mockRejectedValueOnce(new Error("disk error"));
  try {
    start();
    held(["KeyA"]);
    held([]);
    await act(async () => {});
    expect(mocks.error).toHaveBeenCalledWith(
      "Failed to save hotkey. Please try again.",
    );
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    start();
    held(["KeyB"]);
    held([]);
    await act(async () => {});
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1][0].keys).toEqual(["KeyB"]);
  } finally {
    error.mockRestore();
  }
});

it("restores the previous persisted shortcut if a write fails", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  act(() =>
    produceAppState((draft) => {
      draft.hotkeyById.old = {
        id: "old",
        actionName: "dictate",
        keys: ["KeyX"],
      };
      draft.settings.hotkeyIds = ["old"];
    }),
  );
  mocks.save.mockRejectedValueOnce(new Error("disk error"));
  try {
    start();
    held(["KeyK"]);
    held([]);
    await act(async () => {});
    expect(getAppState().hotkeyById.old.keys).toEqual(["KeyX"]);
  } finally {
    error.mockRestore();
  }
});

it("removes a newly created optimistic shortcut if its write fails", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.save.mockRejectedValueOnce(new Error("disk error"));
  try {
    start();
    held(["KeyK"]);
    held([]);
    await act(async () => {});
    expect(getAppState().settings.hotkeyIds).toHaveLength(0);
    expect(
      Object.values(getAppState().hotkeyById).filter(
        (h) => h.actionName === "dictate",
      ),
    ).toHaveLength(0);
  } finally {
    error.mockRestore();
  }
});

it("cancels recording when the window loses focus", () => {
  start();
  held(["KeyK"]);
  act(() => window.dispatchEvent(new Event("blur")));
  expect(getAppState().isRecordingHotkey).toBe(false);
  held([]);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("restores the last successful save after a newer queued save fails", async () => {
  let finishFirst!: () => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  mocks.save.mockRejectedValueOnce(new Error("disk error"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    start();
    held(["KeyA"]);
    held([]);
    await act(async () => {});
    start();
    held(["KeyB"]);
    held([]);
    await act(async () => {});
    await act(async () => {
      finishFirst();
    });
    const id = mocks.save.mock.calls[0][0].id;
    expect(getAppState().hotkeyById[id].keys).toEqual(["KeyA"]);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
  }
});

it("does not roll back a newer external shortcut after a save fails", async () => {
  let fail!: (reason: Error) => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    start();
    held(["KeyA"]);
    held([]);
    await act(async () => {});
    const id = mocks.save.mock.calls[0][0].id;
    act(() =>
      produceAppState((draft) => {
        draft.hotkeyById[id].keys = ["KeyZ"];
      }),
    );
    await act(async () => {
      fail(new Error("disk error"));
    });
    expect(getAppState().hotkeyById[id].keys).toEqual(["KeyZ"]);
  } finally {
    error.mockRestore();
  }
});

it("keeps a saved shortcut if native synchronization fails", async () => {
  mocks.sync.mockRejectedValueOnce(new Error("native error"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    start();
    held(["KeyK"]);
    held([]);
    await act(async () => {});
    const id = mocks.save.mock.calls[0][0].id;
    expect(getAppState().hotkeyById[id].keys).toEqual(["KeyK"]);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Could not activate the current hotkey"),
    );
  } finally {
    error.mockRestore();
  }
});

it("resynchronizes a rollback after an earlier native sync was already in flight", async () => {
  let finishSync!: () => void;
  mocks.sync.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
  );
  mocks.save
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("disk error"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    start();
    held(["KeyA"]);
    held([]);
    await act(async () => {});
    start();
    held(["KeyB"]);
    held([]);
    await act(async () => {});
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSync();
    });
    const id = mocks.save.mock.calls[0][0].id;
    expect(getAppState().hotkeyById[id].keys).toEqual(["KeyA"]);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  } finally {
    error.mockRestore();
  }
});

it("rolls back the right binding when the primary changes during a queued save", async () => {
  let finishFirst!: () => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  mocks.save.mockRejectedValueOnce(new Error("disk error"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    start();
    held(["KeyA"]);
    held([]);
    await act(async () => {});
    act(() =>
      produceAppState((draft) => {
        draft.hotkeyById.other = {
          id: "other",
          actionName: "dictate",
          keys: ["KeyX"],
        };
        draft.settings.hotkeyIds.unshift("other");
      }),
    );
    start();
    held(["KeyB"]);
    held([]);
    await act(async () => {});
    await act(async () => {
      finishFirst();
    });
    expect(getAppState().hotkeyById.other).toEqual({
      id: "other",
      actionName: "dictate",
      keys: ["KeyX"],
    });
  } finally {
    error.mockRestore();
  }
});

it("rolls back an older failed binding even when a different binding is queued", async () => {
  let failFirst!: (reason: Error) => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        failFirst = reject;
      }),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    start();
    held(["KeyA"]);
    held([]);
    await act(async () => {});
    const firstId = mocks.save.mock.calls[0][0].id;
    act(() =>
      produceAppState((draft) => {
        draft.hotkeyById.other = {
          id: "other",
          actionName: "dictate",
          keys: ["KeyX"],
        };
        draft.settings.hotkeyIds.unshift("other");
      }),
    );
    start();
    held(["KeyB"]);
    held([]);
    await act(async () => {});
    await act(async () => {
      failFirst(new Error("disk error"));
    });
    expect(getAppState().hotkeyById[firstId]).toBeUndefined();
    expect(getAppState().hotkeyById.other.keys).toEqual(["KeyB"]);
  } finally {
    error.mockRestore();
  }
});

it("serializes a new recording after the form remounts during a pending save", async () => {
  let finishFirst!: () => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  start();
  held(["KeyA"]);
  held([]);
  await act(async () => {});
  act(() => root.unmount());
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(KeybindingsForm),
      ),
    ),
  );
  start();
  held(["KeyB"]);
  held([]);
  await act(async () => {});
  expect(mocks.save).toHaveBeenCalledTimes(1);
  await act(async () => finishFirst());
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save.mock.calls[1][0].keys).toEqual(["KeyB"]);
});

it("waits for a pending shortcut save before clearing local data", async () => {
  let finishSave!: () => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  start();
  held(["KeyA"]);
  held([]);
  await act(async () => {});
  let drained = false;
  const clearing = beginLocalDataClear().then((release) => {
    drained = true;
    return release;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  start();
  held(["KeyB"]);
  held([]);
  await act(async () => {});
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.error).toHaveBeenCalledWith(
    "Failed to save hotkey. Please try again.",
  );
  await act(async () => finishSave());
  const release = await clearing;
  try {
    expect(drained).toBe(true);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  } finally {
    window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    release();
  }
});

it("ignores the activation key until every held key is released", async () => {
  held(["Return"]);
  start();
  held([]);
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.save).not.toHaveBeenCalled();
  held(["KeyK"]);
  held([]);
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save.mock.calls[0][0].keys).toEqual(["KeyK"]);
});

it("orders onboarding and settings saves of the same shortcut", async () => {
  let finishFirst!: () => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  act(() =>
    root.render(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(KeybindingsForm),
        createElement(HotkeySetting, {
          title: "Dictation",
          description: "",
          actionName: "dictate",
        }),
      ),
    ),
  );
  start();
  held(["KeyA"]);
  held([]);
  await act(async () => {
    await Promise.resolve();
  });
  const setB = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Set B",
  );
  if (!setB) throw new Error("Settings shortcut recorder not found");
  act(() => setB.click());
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.save).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishFirst();
    await Promise.resolve();
  });
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save.mock.calls[1][0].keys).toEqual(["KeyB"]);
});

it("does not roll back a later settings save of the same shortcut value", async () => {
  let failFirst!: (error: Error) => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        failFirst = reject;
      }),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    act(() =>
      root.render(
        createElement(
          ThemeProvider,
          { theme: createTheme() },
          createElement(KeybindingsForm),
          createElement(HotkeySetting, {
            title: "Dictation",
            description: "",
            actionName: "dictate",
          }),
        ),
      ),
    );
    start();
    held(["KeyB"]);
    held([]);
    await act(async () => {
      await Promise.resolve();
    });
    const id = mocks.save.mock.calls[0][0].id;
    const setB = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Set B",
    );
    if (!setB) throw new Error("Settings shortcut recorder not found");
    act(() => setB.click());
    await act(async () => {
      failFirst(new Error("disk error"));
      await Promise.resolve();
    });
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(getAppState().hotkeyById[id].keys).toEqual(["KeyB"]);
    expect(getAppState().settings.hotkeyIds).toContain(id);
  } finally {
    error.mockRestore();
  }
});

it("rolls back to an intervening settings save if a later onboarding save fails", async () => {
  let finishFirst!: () => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  mocks.save
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("disk error"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    act(() =>
      root.render(
        createElement(
          ThemeProvider,
          { theme: createTheme() },
          createElement(KeybindingsForm),
          createElement(HotkeySetting, {
            title: "Dictation",
            description: "",
            actionName: "dictate",
          }),
        ),
      ),
    );
    start();
    held(["KeyA"]);
    held([]);
    await act(async () => {
      await Promise.resolve();
    });
    const id = mocks.save.mock.calls[0][0].id;
    const setB = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Set B",
    );
    if (!setB) throw new Error("Settings shortcut recorder not found");
    act(() => setB.click());
    start();
    held(["KeyC"]);
    held([]);
    await act(async () => {
      finishFirst();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(3));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getAppState().hotkeyById[id].keys).toEqual(["KeyB"]);
  } finally {
    error.mockRestore();
  }
});
