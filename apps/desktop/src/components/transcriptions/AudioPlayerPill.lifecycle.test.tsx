// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const { load, play, error, seek } = vi.hoisted(() => ({
  load: vi.fn(),
  play: vi.fn(),
  error: vi.fn(),
  seek: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../repos", () => ({
  getTranscriptionRepo: () => ({ loadTranscriptionAudio: load }),
}));
vi.mock("../../actions/app.actions", () => ({ showErrorSnackbar: error }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
vi.mock("../../utils/audio-playback.utils", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/audio-playback.utils")
  >()),
  playWebAudio: play,
  seekPlayback: seek,
}));
import { AudioPlayerPill } from "./AudioPlayerPill";
ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
const audio = { samples: [0, 0], sampleRate: 16000 };
const deferred = () => {
  let resolve!: (value: typeof audio) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof audio>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.clearAllMocks();
  play.mockImplementation(() => Promise.resolve());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = async (ids = ["a"]) => {
  await act(() =>
    root.render(
      <IntlProvider locale="en">
        {ids.map((id) => (
          <AudioPlayerPill key={id} transcriptionId={id} />
        ))}
      </IntlProvider>,
    ),
  );
};
const click = async (index = 0) => {
  await act(() =>
    container.querySelectorAll<HTMLButtonElement>("button")[index].click(),
  );
};
it("acknowledges a pending read and cancels without playing late audio", async () => {
  const pending = deferred();
  load.mockReturnValue(pending.promise);
  await render();
  await click();
  expect(
    container.querySelector('[aria-label="Cancel audio loading"]'),
  ).not.toBeNull();
  await click();
  await act(() => pending.resolve(audio));
  expect(play).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Play audio"]')).not.toBeNull();
});
it("does not start audio after its row unmounts", async () => {
  const pending = deferred();
  load.mockReturnValue(pending.promise);
  await render();
  await click();
  await render([]);
  await act(() => pending.resolve(audio));
  expect(play).not.toHaveBeenCalled();
});
it("the newest row wins even if an earlier read completes last", async () => {
  const a = deferred();
  const b = deferred();
  load.mockImplementation((id) => (id === "a" ? a.promise : b.promise));
  await render(["a", "b"]);
  await click(0);
  await click(1);
  await act(() => b.resolve(audio));
  await act(() => a.resolve(audio));
  expect(play).toHaveBeenCalledTimes(1);
  expect(play.mock.calls[0][0]).toBe("b");
});
it("suppresses errors from cancelled work and permits retry", async () => {
  const pending = deferred();
  load.mockReturnValueOnce(pending.promise).mockResolvedValue(audio);
  await render();
  await click();
  await click();
  await act(() => pending.reject(new Error("missing private/path.wav")));
  expect(error).not.toHaveBeenCalled();
  await click();
  expect(play).toHaveBeenCalledTimes(1);
});
it("names the read stage when the saved audio cannot be loaded, and retries", async () => {
  load.mockRejectedValueOnce(new Error("missing")).mockResolvedValue(audio);
  await render();
  await click();
  expect(error).toHaveBeenCalledExactlyOnceWith(
    "The saved audio for this entry is unavailable.",
  );
  expect(container.querySelector('[aria-label="Play audio"]')).not.toBeNull();
  await click();
  expect(play).toHaveBeenCalledTimes(1);
});
it("reports a startup failure even when playback teardown notifies stop first", async () => {
  load.mockResolvedValue(audio);
  play.mockImplementationOnce((_id, _audio, _progress, onStop) => {
    onStop("stopped");
    return Promise.reject(new Error("source start failed"));
  });
  await render();
  await click();
  expect(error).toHaveBeenCalledExactlyOnceWith(
    "Unable to play audio snippet.",
  );
  expect(container.querySelector('[aria-label="Play audio"]')).not.toBeNull();
  await click();
  expect(play).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[aria-label="Pause audio"]')).not.toBeNull();
});
it("does not show playing if the source ends before preparation resolves", async () => {
  load.mockResolvedValue(audio);
  play.mockImplementationOnce((_id, _audio, _progress, onStop) => {
    onStop("ended");
    return Promise.resolve();
  });
  await render();
  await click();
  expect(error).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Play audio"]')).not.toBeNull();
  await click();
  expect(play).toHaveBeenCalledTimes(2);
});
it("releases request ownership when playback ends and can play again", async () => {
  load.mockResolvedValue(audio);
  await render();
  await click();
  const onStop = play.mock.calls[0][3];
  const signal: AbortSignal = play.mock.calls[0][5];
  await act(() => onStop("ended"));
  expect(signal.aborted).toBe(true);
  expect(container.querySelector('[aria-label="Play audio"]')).not.toBeNull();
  await click();
  expect(play).toHaveBeenCalledTimes(2);
});
it("surfaces a real utility startup rejection after releasing the context", async () => {
  const actual = await vi.importActual<
    typeof import("../../utils/audio-playback.utils")
  >("../../utils/audio-playback.utils");
  const close = vi.fn(async () => undefined);
  const source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    stop: vi.fn(),
    onended: null,
    start: vi.fn(() => {
      throw new Error("device start failed");
    }),
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      close = close;
      createBufferSource = () => source;
      createBuffer = () => ({
        duration: 1,
        getChannelData: () => new Float32Array(2),
      });
    },
  );
  try {
    load.mockResolvedValue(audio);
    play.mockImplementationOnce(actual.playWebAudio);
    await render();
    await click();
    expect(source.start).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(actual.activePlayback).toBeNull();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "Unable to play audio snippet.",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

const renderSingle = async (id = "a", disabled = false) => {
  await act(() =>
    root.render(
      <StrictMode>
        <IntlProvider locale="en">
          <AudioPlayerPill transcriptionId={id} disabled={disabled} />
        </IntlProvider>
      </StrictMode>,
    ),
  );
};
it("rejects the old read when a mounted row changes identity", async () => {
  const pending = deferred();
  load.mockReturnValueOnce(pending.promise).mockResolvedValue(audio);
  await renderSingle();
  await click();
  await renderSingle("b");
  await act(() => pending.resolve(audio));
  expect(play).not.toHaveBeenCalled();
  await click();
  expect(play).toHaveBeenCalledOnce();
  expect(play.mock.calls[0][0]).toBe("b");
});
it("resumes progress updates after an identity change cuts a drag short", async () => {
  load.mockResolvedValue(audio);
  await renderSingle();
  await click();
  expect(play).toHaveBeenCalledOnce();
  const slider = () => {
    const el = container.querySelector<HTMLElement>('[role="slider"]');
    if (!el) throw new Error("missing slider");
    return el;
  };
  await act(() => {
    slider().dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );
  });
  await renderSingle("b");
  await click();
  expect(play).toHaveBeenCalledTimes(2);
  const onProgress = play.mock.calls[1][2] as (progress: number) => void;
  act(() => onProgress(0.5));
  expect(slider().getAttribute("aria-valuenow")).toBe("50");
});
it("does not seek after an identity change while playing", async () => {
  load.mockResolvedValue(audio);
  await renderSingle();
  await click();
  const slider = () => {
    const el = container.querySelector<HTMLElement>('[role="slider"]');
    if (!el) throw new Error("missing slider");
    return el;
  };
  const drag = async () => {
    await act(() => {
      slider().dispatchEvent(
        new Event("pointerdown", { bubbles: true, cancelable: true }),
      );
    });
    await act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
  };
  await drag();
  expect(seek).toHaveBeenCalledOnce();
  seek.mockClear();
  await renderSingle("b");
  await drag();
  expect(seek).not.toHaveBeenCalled();
});
it("cancels disabled rows and permits retry after re-enabling", async () => {
  const pending = deferred();
  load.mockReturnValueOnce(pending.promise).mockResolvedValue(audio);
  await renderSingle();
  await click();
  await renderSingle("a", true);
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(() => pending.reject(new Error("old read failed")));
  expect(error).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
  await renderSingle();
  await click();
  expect(play).toHaveBeenCalledOnce();
});
it("starts only one read under StrictMode and cancels it on unmount", async () => {
  const pending = deferred();
  load.mockReturnValueOnce(pending.promise);
  await renderSingle();
  await click();
  expect(load).toHaveBeenCalledOnce();
  await render([]);
  await act(() => pending.resolve(audio));
  expect(play).not.toHaveBeenCalled();
});
it.each([false, true])(
  "clear cancels playback with a completed read of %s",
  async (loaded) => {
    const { beginLocalDataClear, LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY } =
      await import("../../utils/local-data-write-gate");
    const pending = deferred();
    load
      .mockReturnValueOnce(loaded ? Promise.resolve(audio) : pending.promise)
      .mockResolvedValue(audio);
    await renderSingle();
    await click();
    let release: (() => void) | undefined;
    try {
      await act(async () => {
        release = await beginLocalDataClear();
      });
      if (loaded)
        expect((play.mock.calls[0][5] as AbortSignal).aborted).toBe(true);
      else {
        await act(() => pending.resolve(audio));
        expect(play).not.toHaveBeenCalled();
      }
      expect(
        container.querySelector('[aria-label="Play audio"]'),
      ).not.toBeNull();
      expect(error).not.toHaveBeenCalled();
    } finally {
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      release?.();
    }
    await click();
    expect(play).toHaveBeenCalledTimes(loaded ? 2 : 1);
  },
);
