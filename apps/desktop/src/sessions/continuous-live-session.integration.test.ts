import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptionSession } from "../types/transcription-session.types";

const events = vi.hoisted(() => ({
  listener: null as
    | null
    | ((event: {
        payload: { samples: number[]; offset?: number; ownerId?: string };
      }) => void),
  failListen: false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, listener: typeof events.listener) => {
    if (events.failListen) throw new Error("subscription failed");
    events.listener = listener;
    return () => {
      events.listener = null;
    };
  },
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    verbose: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  attachSessionAudioIntake,
  forwardAudioChunk,
} from "../components/root/dictation-recording-intake";
import { ContinuousLiveSession } from "./continuous-live-session";

const source = () =>
  ({
    onRecordingStart: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue({
      rawTranscript: "complete",
      metadata: {},
      warnings: [],
    }),
    cleanup: vi.fn(),
    writeAudioChunk: vi.fn(),
    supportsStreaming: () => true,
    setInterimResultCallback: vi.fn(),
  }) satisfies TranscriptionSession;
const emit = (samples: number[], offset?: number) =>
  events.listener?.({ payload: { samples, offset, ownerId: "owner" } });
const audio = (length: number) => ({
  samples: Float32Array.from({ length }, (_, index) => index + 1),
  sampleRate: 16000,
});

afterEach(() => {
  events.listener = null;
  events.failListen = false;
  vi.useRealTimers();
});

describe("continuity through the actual recording intake", () => {
  it("replays startup and waits for the final delayed event", async () => {
    vi.useFakeTimers();
    const provider = source();
    const session = new ContinuousLiveSession(provider);
    let ready = false;
    const intake = await attachSessionAudioIntake(
      session,
      () => true,
      () => ready,
      vi.fn(),
      "owner",
    );
    emit([1, 2], 0);
    await session.onRecordingStart(16000);
    intake.buffer.setSink((chunk, offset) =>
      forwardAudioChunk(session, chunk, offset),
    );
    intake.buffer.replay();
    intake.buffer.reset();
    ready = true;
    emit([3], 2);
    const pending = session.finalize(audio(4));
    await vi.advanceTimersByTimeAsync(100);
    emit([4], 3);
    await expect(pending).resolves.toMatchObject({ rawTranscript: "complete" });
    expect(provider.writeAudioChunk).toHaveBeenCalledTimes(3);
    expect(provider.finalize).toHaveBeenCalledOnce();
    intake.unlisten?.();
  });

  it("fails rather than accepting partial text after a listener failure", async () => {
    vi.useFakeTimers();
    events.failListen = true;
    const provider = source();
    const session = new ContinuousLiveSession(provider);
    const intake = await attachSessionAudioIntake(
      session,
      () => true,
      () => true,
      vi.fn(),
      "owner",
    );
    expect(intake.unlisten).toBeNull();
    await session.onRecordingStart(16000);
    const pending = session.finalize(audio(2));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.any(String)],
    });
    expect(provider.finalize).not.toHaveBeenCalled();
  });

  it("drops malformed startup chunks before they can be coerced and replayed", async () => {
    vi.useFakeTimers();
    const provider = source();
    const session = new ContinuousLiveSession(provider);
    const overflow = vi.fn();
    const intake = await attachSessionAudioIntake(
      session,
      () => true,
      () => false,
      overflow,
      "owner",
    );
    emit([0.5, null as unknown as number], 0);
    expect(overflow).toHaveBeenCalledWith(2);
    await session.onRecordingStart(16000);
    intake.buffer.setSink((chunk, offset) =>
      forwardAudioChunk(session, chunk, offset),
    );
    intake.buffer.replay();
    const result = session.finalize(audio(2));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.any(String)],
    });
    expect(provider.writeAudioChunk).not.toHaveBeenCalled();
    expect(provider.finalize).not.toHaveBeenCalled();
    intake.unlisten?.();
  });

  it("rejects malformed chunks rather than sending coerced samples to the provider", async () => {
    vi.useFakeTimers();
    const provider = source();
    const session = new ContinuousLiveSession(provider);
    const intake = await attachSessionAudioIntake(
      session,
      () => true,
      () => true,
      vi.fn(),
      "owner",
    );
    await session.onRecordingStart(16000);
    emit([1], 0);
    emit([null as unknown as number], 1);
    const pending = session.finalize(audio(2));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.any(String)],
    });
    expect(provider.writeAudioChunk).toHaveBeenCalledOnce();
    expect(provider.finalize).not.toHaveBeenCalled();
    intake.unlisten?.();
  });

  it("fails when an unindexed event creates a gap in the recording", async () => {
    const provider = source();
    const session = new ContinuousLiveSession(provider);
    const intake = await attachSessionAudioIntake(
      session,
      () => true,
      () => true,
      vi.fn(),
      "owner",
    );
    await session.onRecordingStart(16000);
    emit([1], 0);
    emit([2]);
    emit([3], 2);
    await expect(session.finalize(audio(3))).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.any(String)],
    });
    expect(provider.finalize).not.toHaveBeenCalled();
    intake.unlisten?.();
  });
});
