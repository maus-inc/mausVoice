import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import { listenToAudioChunks } from "./audio-chunk-events";

describe("audio chunk admission identity", () => {
  it("rejects chunks from an earlier admission with the same owner ID", async () => {
    let receive!: (event: { payload: unknown }) => void;
    mocks.listen.mockImplementation(async (_name, callback) => {
      receive = callback;
      return () => undefined;
    });
    let token: number | null = null;
    const onChunk = vi.fn();
    await listenToAudioChunks(onChunk, "reused", () => token);
    const deliver = (generation: number) =>
      receive({
        payload: { ownerId: "reused", generation, samples: [0.5], offset: 0 },
      });
    deliver(1);
    token = 2;
    deliver(1);
    deliver(2);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith([0.5], 0);
  });

  it("rejects payloads without an audio sample array", async () => {
    let receive!: (event: { payload: unknown }) => void;
    mocks.listen.mockImplementation(async (_name, callback) => {
      receive = callback;
      return () => undefined;
    });
    const onChunk = vi.fn();
    await listenToAudioChunks(onChunk, "owner", () => 4);
    for (const samples of [null, "audio", [], {}]) {
      receive({
        payload: { ownerId: "owner", generation: 4, samples, offset: 0 },
      });
    }
    receive({ payload: null });
    expect(onChunk).not.toHaveBeenCalled();
    receive({
      payload: { ownerId: "owner", generation: 4, samples: [0.5], offset: 0 },
    });
    expect(onChunk).toHaveBeenCalledExactlyOnceWith([0.5], 0);
  });

  it("rejects missing or invalid admission tokens and marks invalid offsets unindexed", async () => {
    let receive!: (event: { payload: unknown }) => void;
    mocks.listen.mockImplementation(async (_name, callback) => {
      receive = callback;
      return () => undefined;
    });
    let token: number | null | undefined;
    const onChunk = vi.fn();
    await listenToAudioChunks(onChunk, "owner", () => token as number | null);
    receive({ payload: { ownerId: "owner", samples: [0.5], offset: 0 } });
    token = NaN;
    receive({
      payload: { ownerId: "owner", generation: NaN, samples: [0.5], offset: 0 },
    });
    expect(onChunk).not.toHaveBeenCalled();
    token = 4;
    for (const offset of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      receive({
        payload: { ownerId: "owner", generation: 4, samples: [0.5], offset },
      });
    }
    expect(onChunk).toHaveBeenCalledTimes(4);
    expect(onChunk).toHaveBeenCalledWith([0.5], null);
  });
});
