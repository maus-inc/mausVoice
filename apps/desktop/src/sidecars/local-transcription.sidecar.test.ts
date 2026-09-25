import { afterEach, describe, expect, it, vi } from "vitest";

const secureFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/secure-fetch.utils", () => ({
  secureFetch: secureFetchMock,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    verbose: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

import { LocalTranscriptionSidecar } from "./local-transcription.sidecar";

type SidecarInternals = {
  ensureModelReady: () => Promise<void>;
  resetRuntime: () => Promise<void>;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

const transcribeInput = (signal: AbortSignal) => ({
  model: "tiny" as const,
  samples: new Float32Array(160),
  sampleRate: 16000,
  preferGpu: false,
  signal,
});

afterEach(() => {
  vi.restoreAllMocks();
  secureFetchMock.mockReset();
});

describe("LocalTranscriptionSidecar abort handling", () => {
  it("aborts finalize without retrying or resetting the runtime, then releases the session", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    const internals = sidecar as unknown as SidecarInternals;
    vi.spyOn(sidecar, "ensureStarted").mockResolvedValue({
      baseUrl: "http://127.0.0.1:1",
    } as Awaited<ReturnType<typeof sidecar.ensureStarted>>);
    vi.spyOn(internals, "ensureModelReady").mockResolvedValue();
    const resetRuntime = vi
      .spyOn(internals, "resetRuntime")
      .mockResolvedValue();

    const controller = new AbortController();
    const calls: string[] = [];
    secureFetchMock.mockImplementation(
      async (url: string, init?: RequestInit) => {
        const call = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
        calls.push(call);
        if (call === "POST /v1/transcriptions/sessions") {
          return json({ sessionId: "s1" });
        }
        if (call.endsWith("/finalize")) {
          expect(init?.signal).toBe(controller.signal);
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        }
        return json({});
      },
    );

    await expect(
      sidecar.transcribe(transcribeInput(controller.signal)),
    ).rejects.toThrow("aborted");

    expect(calls.filter((call) => call.endsWith("/finalize"))).toHaveLength(1);
    expect(calls).toContain("DELETE /v1/transcriptions/sessions/s1");
    expect(resetRuntime).not.toHaveBeenCalled();
  });

  it("does not open a session when already aborted", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    const controller = new AbortController();
    controller.abort();

    await expect(
      sidecar.transcribe(transcribeInput(controller.signal)),
    ).rejects.toThrow();
    expect(secureFetchMock).not.toHaveBeenCalled();
  });
});
