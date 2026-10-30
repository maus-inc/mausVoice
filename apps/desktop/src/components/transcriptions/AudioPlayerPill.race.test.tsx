// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  play: vi.fn(),
  stop: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
vi.mock("../../repos", () => ({
  getTranscriptionRepo: () => ({ loadTranscriptionAudio: mocks.load }),
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.error,
}));
vi.mock("../../utils/audio-playback.utils", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/audio-playback.utils")
  >()),
  playWebAudio: (...args: unknown[]) => mocks.play(...args),
  stopActivePlayback: (...args: unknown[]) => mocks.stop(...args),
}));
import en from "../../i18n/locales/en.json";
import { AudioPlayerPill } from "./AudioPlayerPill";
ensureUiHarness();
setMatchMedia(true);
const audio = { samples: [0], sampleRate: 16000 };
const deferred = () => {
  let resolve!: (value: typeof audio) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<typeof audio>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const pill = (id: string) =>
  createElement(AudioPlayerPill, { key: id, transcriptionId: id });
const render = (root: ReturnType<typeof createRoot>, ids: string[]) =>
  act(() =>
    root.render(
      createElement(
        IntlProvider,
        { locale: "en", messages: en },
        ...ids.map(pill),
      ),
    ),
  );
const setup = () => {
  mocks.load.mockReset();
  mocks.play.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset();
  mocks.error.mockReset();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    root,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
};

it("does not start playback after the row is removed during loading", async () => {
  const { host, root, cleanup } = setup();
  const pending = deferred();
  mocks.load.mockReturnValue(pending.promise);
  try {
    render(root, ["one"]);
    act(() =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click(),
    );
    render(root, []);
    await act(async () => {
      pending.resolve(audio);
      await pending.promise;
    });
    expect(mocks.play).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

it("does not allow an older slow load to replace a newer row", async () => {
  const { host, root, cleanup } = setup();
  const first = deferred(),
    second = deferred();
  mocks.load.mockImplementation((id: string) =>
    id === "one" ? first.promise : second.promise,
  );
  try {
    render(root, ["one", "two"]);
    const buttons = host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Play audio"]',
    );
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    await act(async () => {
      second.resolve(audio);
      await second.promise;
    });
    await act(async () => {
      first.resolve(audio);
      await first.promise;
    });
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.play.mock.calls[0]![0]).toBe("two");
  } finally {
    cleanup();
  }
});

it("ignores a stale load error after another row is chosen", async () => {
  const { host, root, cleanup } = setup();
  const first = deferred(),
    second = deferred();
  mocks.load.mockImplementation((id: string) =>
    id === "one" ? first.promise : second.promise,
  );
  try {
    render(root, ["one", "two"]);
    const buttons = host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Play audio"]',
    );
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    await act(async () => {
      first.reject(new Error("old load failed"));
      await first.promise.catch(() => {});
    });
    expect(mocks.error).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve(audio);
      await second.promise;
    });
    expect(mocks.play).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
  }
});

it("does not stop a newer row when the old row unmounts", async () => {
  const { host, root, cleanup } = setup();
  const first = deferred(),
    second = deferred();
  mocks.load.mockImplementation((id: string) =>
    id === "one" ? first.promise : second.promise,
  );
  try {
    render(root, ["one", "two"]);
    const buttons = host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Play audio"]',
    );
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    mocks.stop.mockClear();
    render(root, ["two"]);
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve(audio);
      await second.promise;
    });
    expect(mocks.play.mock.calls[0]![0]).toBe("two");
  } finally {
    cleanup();
  }
});

it("cancels Web Audio initialization if the owning row unmounts", async () => {
  const { host, root, cleanup } = setup();
  let finish!: () => void;
  const initializing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.load.mockResolvedValue(audio);
  mocks.play.mockReturnValue(initializing);
  try {
    render(root, ["one"]);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click();
      await Promise.resolve();
    });
    mocks.stop.mockClear();
    render(root, []);
    expect(mocks.stop).toHaveBeenCalledWith("stopped");
    await act(async () => {
      finish();
      await initializing;
    });
  } finally {
    cleanup();
  }
});

it("cancels a pending audio load when the row becomes disabled", async () => {
  const { host, root, cleanup } = setup();
  const pending = deferred();
  mocks.load.mockReturnValue(pending.promise);
  try {
    render(root, ["one"]);
    act(() =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click(),
    );
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(AudioPlayerPill, {
            key: "one",
            transcriptionId: "one",
            disabled: true,
          }),
        ),
      ),
    );
    expect(mocks.stop).toHaveBeenLastCalledWith("stopped");
    await act(async () => {
      pending.resolve(audio);
      await pending.promise;
    });
    expect(mocks.play).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});
