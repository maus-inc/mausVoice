// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("../common/MetalChrome", () => ({
  MetalChrome: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../../actions/app.actions", () => ({ showErrorSnackbar: vi.fn() }));
vi.mock("../../repos", () => ({ getTranscriptionRepo: vi.fn() }));

import { AudioPlayerPill } from "./AudioPlayerPill";
import { getTranscriptionRepo } from "../../repos";
import * as audioPlayback from "../../utils/audio-playback.utils";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AudioPlayerPill transcriptionId="test" durationMs={1000} />);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  audioPlayback.stopActivePlayback("stopped");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const pointer = (target: EventTarget, type: string, clientX: number) => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
};

describe("AudioPlayerPill seeking", () => {
  it("commits a clamped pointer seek and restores it on a cancelled drag", () => {
    const slider = container.querySelector<HTMLElement>('[role="slider"]');
    if (!slider) throw new Error("Missing playback slider");
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 10,
      width: 100,
    } as DOMRect);
    act(() => pointer(slider, "pointerdown", 30));
    expect(slider.getAttribute("aria-valuenow")).toBe("20");
    act(() => pointer(window, "pointerup", 200));
    expect(slider.getAttribute("aria-valuenow")).toBe("100");
    act(() => pointer(slider, "pointerdown", 40));
    expect(slider.getAttribute("aria-valuenow")).toBe("30");
    act(() => pointer(window, "pointermove", 60));
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    act(() => pointer(window, "pointercancel", 60));
    expect(slider.getAttribute("aria-valuenow")).toBe("100");
    act(() => pointer(window, "pointermove", 15));
    expect(slider.getAttribute("aria-valuenow")).toBe("100");
  });
});

it("supports keyboard seeking but ignores it when disabled", async () => {
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
  await act(async () =>
    slider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(slider.getAttribute("aria-valuenow")).toBe("5");
  await act(async () =>
    root.render(<AudioPlayerPill transcriptionId="test" disabled />),
  );
  await act(async () =>
    slider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(slider.getAttribute("aria-valuenow")).toBe("5");
});

it("retires an active seek when the row changes identity", async () => {
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 100,
  } as DOMRect);
  act(() => pointer(slider, "pointerdown", 50));
  await act(async () =>
    root.render(<AudioPlayerPill transcriptionId="other" durationMs={1000} />),
  );
  expect(slider.getAttribute("aria-valuenow")).toBe("0");
  act(() => pointer(window, "pointermove", 80));
  expect(slider.getAttribute("aria-valuenow")).toBe("0");
});

describe("AudioPlayerPill request ownership", () => {
  const audio = { samples: [0, 0.5], sampleRate: 16000 };
  const setupPendingAudio = () => {
    let resolve: (value: typeof audio) => void = () => undefined;
    const pending = new Promise<typeof audio>((done) => {
      resolve = done;
    });
    vi.mocked(getTranscriptionRepo).mockReturnValue({
      loadTranscriptionAudio: () => pending,
    } as unknown as ReturnType<typeof getTranscriptionRepo>);
    const play = vi
      .spyOn(audioPlayback, "playWebAudio")
      .mockResolvedValue(undefined);
    return { resolve, play };
  };

  it("does not start playback after its row is unmounted", async () => {
    const { resolve, play } = setupPendingAudio();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click(),
    );
    await act(async () => root.render(<div />));
    await act(async () => {
      resolve(audio);
      await Promise.resolve();
    });
    expect(play).not.toHaveBeenCalled();
  });

  it("does not start an old recording after its row changes identity", async () => {
    const { resolve, play } = setupPendingAudio();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click(),
    );
    await act(async () =>
      root.render(
        <AudioPlayerPill transcriptionId="other" durationMs={1000} />,
      ),
    );
    await act(async () => {
      resolve(audio);
      await Promise.resolve();
    });
    expect(play).not.toHaveBeenCalled();
  });

  it("resets playback state when a playing row changes identity", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        close() {
          return Promise.resolve();
        }
        createBuffer() {
          return { duration: 1, getChannelData: () => new Float32Array(2) };
        }
        createBufferSource() {
          return {
            start: vi.fn(),
            connect: vi.fn(),
            stop: vi.fn(),
            disconnect: vi.fn(),
            onended: null,
          };
        }
      },
    );
    vi.mocked(getTranscriptionRepo).mockReturnValue({
      loadTranscriptionAudio: () => Promise.resolve(audio),
    } as unknown as ReturnType<typeof getTranscriptionRepo>);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('button[aria-label="Pause audio"]'),
    ).not.toBeNull();
    await act(async () =>
      root.render(
        <AudioPlayerPill transcriptionId="other" durationMs={1000} />,
      ),
    );
    expect(
      container.querySelector('button[aria-label="Play audio"]'),
    ).not.toBeNull();
    expect(audioPlayback.activePlayback).toBeNull();
  });

  it("returns to the play state when playback is stopped", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        close() {
          return Promise.resolve();
        }
        createBuffer() {
          return { duration: 1, getChannelData: () => new Float32Array(2) };
        }
        createBufferSource() {
          return {
            start: vi.fn(),
            connect: vi.fn(),
            stop: vi.fn(),
            disconnect: vi.fn(),
            onended: null,
          };
        }
      },
    );
    vi.mocked(getTranscriptionRepo).mockReturnValue({
      loadTranscriptionAudio: () => Promise.resolve(audio),
    } as unknown as ReturnType<typeof getTranscriptionRepo>);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click();
      await Promise.resolve();
    });
    const pause = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pause audio"]',
    )!;
    expect(pause).not.toBeNull();
    await act(async () => pause.click());
    expect(
      container.querySelector('button[aria-label="Play audio"]'),
    ).not.toBeNull();
  });

  it("does not surface an error from a retired audio load", async () => {
    let reject: (error: Error) => void = () => undefined;
    const pending = new Promise<typeof audio>((_resolve, fail) => {
      reject = fail;
    });
    vi.mocked(getTranscriptionRepo).mockReturnValue({
      loadTranscriptionAudio: () => pending,
    } as unknown as ReturnType<typeof getTranscriptionRepo>);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click(),
    );
    await act(async () => root.render(<div />));
    await act(async () => {
      reject(new Error("retired private error"));
      await Promise.resolve();
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("cancels this row's audio while its context is still resuming", async () => {
    let resume: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const start = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        currentTime = 0;
        destination = {};
        resume = () => pending;
        close = close;
        createBuffer = () => ({
          duration: 1,
          getChannelData: () => new Float32Array(2),
        });
        createBufferSource = () => ({
          start,
          connect: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          onended: null,
        });
      },
    );
    vi.mocked(getTranscriptionRepo).mockReturnValue({
      loadTranscriptionAudio: () => Promise.resolve(audio),
    } as unknown as ReturnType<typeof getTranscriptionRepo>);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click();
      await Promise.resolve();
    });
    await act(async () => root.render(<div />));
    await act(async () => {
      resume();
      await Promise.resolve();
    });
    expect(start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not put opaque repository errors into logs", async () => {
    vi.mocked(getTranscriptionRepo).mockReturnValue({
      loadTranscriptionAudio: () =>
        Promise.reject(new Error("private transcript or credential")),
    } as unknown as ReturnType<typeof getTranscriptionRepo>);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Play audio"]')!
        .click();
      await Promise.resolve();
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "Failed to toggle audio playback",
    );
  });
});

it("recomputes waveform density as the track is resized", async () => {
  let resize: ResizeObserverCallback = () => undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    },
  );
  await act(async () =>
    root.render(
      <AudioPlayerPill transcriptionId="resized" durationMs={1000} />,
    ),
  );
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
  await act(async () =>
    resize(
      [{ contentRect: { width: 50 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  const narrow = slider.children.length;
  await act(async () =>
    resize(
      [{ contentRect: { width: 250 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  expect(slider.children.length).toBeGreaterThan(narrow);
  await act(async () => root.render(<div />));
  expect(disconnect).toHaveBeenCalled();
});
