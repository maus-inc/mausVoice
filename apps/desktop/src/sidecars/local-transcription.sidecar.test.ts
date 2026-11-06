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

describe("LocalTranscriptionSidecar health response", () => {
  it("cancels a stalled health body when its probe is retired", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    const check = sidecar as unknown as {
      checkHealthResponse(
        response: Response,
        signal: AbortSignal,
      ): Promise<boolean>;
    };
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = check.checkHealthResponse(response, controller.signal);
    const result = expect(pending).rejects.toBe("health cancelled");
    controller.abort("health cancelled");
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });
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
    secureFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const call = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
      calls.push(call);
      if (call === "POST /v1/transcriptions/sessions") {
        return Promise.resolve(json({ sessionId: "s1" }));
      }
      if (call.endsWith("/finalize")) {
        // The deadline helper uses its own signal and forwards caller aborts.
        expect(init?.signal).not.toBe(controller.signal);
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(json({}));
    });

    await expect(
      sidecar.transcribe(transcribeInput(controller.signal)),
    ).rejects.toThrow("aborted");

    expect(calls.filter((call) => call.endsWith("/finalize"))).toHaveLength(1);
    expect(calls).toContain("DELETE /v1/transcriptions/sessions/s1");
    expect(resetRuntime).not.toHaveBeenCalled();
  });

  it("stops uploading queued chunks once aborted", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    const internals = sidecar as unknown as SidecarInternals;
    vi.spyOn(sidecar, "ensureStarted").mockResolvedValue({
      baseUrl: "http://127.0.0.1:1",
    } as Awaited<ReturnType<typeof sidecar.ensureStarted>>);
    vi.spyOn(internals, "ensureModelReady").mockResolvedValue();

    const controller = new AbortController();
    const calls: string[] = [];
    secureFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const call = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
      calls.push(call);
      if (call === "POST /v1/transcriptions/sessions") {
        return Promise.resolve(json({ sessionId: "s2" }));
      }
      if (call.endsWith("/chunks")) {
        // The deadline helper uses its own signal and forwards caller aborts.
        expect(init?.signal).not.toBe(controller.signal);
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(json({}));
    });

    await expect(
      sidecar.transcribe({
        ...transcribeInput(controller.signal),
        samples: new Float32Array(16_000 * 3),
      }),
    ).rejects.toThrow();

    expect(calls.filter((call) => call.endsWith("/chunks"))).toHaveLength(1);
    expect(calls.some((call) => call.endsWith("/finalize"))).toBe(false);
    expect(calls).toContain("DELETE /v1/transcriptions/sessions/s2");
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

describe("LocalTranscriptionSidecar model validation", () => {
  type DownloadInternals = {
    downloadModelInternal: (
      model: "tiny",
    ) => Promise<
      import("./local-transcription.sidecar").LocalSidecarDownloadSnapshot
    >;
    ensureModelReady: (model: "tiny") => Promise<void>;
  };
  const snapshot = (status: "completed" | "paused") => ({
    jobId: "job",
    model: "tiny" as const,
    status,
    bytesDownloaded: 10,
    totalBytes: 10,
    progress: 1,
    error: null,
  });
  const status = (
    downloaded: boolean,
    valid: boolean,
    validationError: string | null = null,
  ) => ({
    model: "tiny" as const,
    downloaded,
    valid,
    fileBytes: 10,
    validationError,
  });

  it("does not validate a paused download", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    const internals = sidecar as unknown as DownloadInternals;
    vi.spyOn(internals, "downloadModelInternal").mockResolvedValue(
      snapshot("paused"),
    );
    const getStatus = vi.spyOn(sidecar, "getModelStatus");
    await expect(sidecar.downloadModel("tiny")).resolves.toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("returns a successfully validated download and caches its readiness", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    const internals = sidecar as unknown as DownloadInternals;
    vi.spyOn(internals, "downloadModelInternal").mockResolvedValue(
      snapshot("completed"),
    );
    const valid = status(true, true);
    const getStatus = vi
      .spyOn(sidecar, "getModelStatus")
      .mockResolvedValue(valid);
    await expect(sidecar.downloadModel("tiny")).resolves.toEqual(valid);
    await internals.ensureModelReady("tiny");
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith("tiny", true);
  });

  it("keeps the provider validation error in both download and readiness paths", async () => {
    const sidecar = new LocalTranscriptionSidecar("gpu");
    const internals = sidecar as unknown as DownloadInternals;
    vi.spyOn(internals, "downloadModelInternal").mockResolvedValue(
      snapshot("completed"),
    );
    vi.spyOn(sidecar, "getModelStatus").mockResolvedValue(
      status(true, false, "bad checksum"),
    );
    await expect(sidecar.downloadModel("tiny")).rejects.toThrow("bad checksum");
    await expect(internals.ensureModelReady("tiny")).rejects.toThrow(
      "bad checksum",
    );
  });

  it("reports the model and mode when validation has no detail", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    const internals = sidecar as unknown as DownloadInternals;
    vi.spyOn(internals, "downloadModelInternal").mockResolvedValue(
      snapshot("completed"),
    );
    vi.spyOn(sidecar, "getModelStatus").mockResolvedValue(status(false, false));
    await expect(sidecar.downloadModel("tiny")).rejects.toThrow(
      "Model 'tiny' failed validation (CPU)",
    );
  });
});

describe("sidecar HTTP error decoding", () => {
  const decode = (response: Response) =>
    (
      new LocalTranscriptionSidecar("cpu") as unknown as {
        buildHttpError: (
          response: Response,
        ) => Promise<Error & { status?: number; code?: string }>;
      }
    ).buildHttpError(response);

  it("preserves the plain-text body when the response is not JSON", async () => {
    const error = await decode(
      new Response(" model unavailable \n", { status: 404 }),
    );
    expect(error.message).toBe("model unavailable");
    expect(error.status).toBe(404);
    expect(error.code).toBeUndefined();
  });

  it("preserves structured error details", async () => {
    const error = await decode(
      new Response(
        JSON.stringify({
          error: { code: "model_not_downloaded", message: "download first" },
        }),
        { status: 404 },
      ),
    );
    expect(error.message).toBe("download first");
    expect(error.status).toBe(404);
    expect(error.code).toBe("model_not_downloaded");
  });

  it("retains structured codes when sanitizing sensitive error messages", async () => {
    const error = await decode(
      new Response(
        JSON.stringify({
          error: {
            code: "download_failed",
            message: "upstream token=private-fragment",
          },
        }),
        { status: 500 },
      ),
    );
    expect(error.code).toBe("download_failed");
    expect(error.message).not.toContain("private-fragment");
  });

  it("redacts credentials in a plain-text model-management diagnostic", async () => {
    const error = await decode(
      new Response("authorization: Bearer private-fragment", { status: 500 }),
    );
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("private-fragment");
  });

  it("does not retain oversized diagnostics", async () => {
    const error = await decode(
      new Response("x".repeat(20_000), { status: 500 }),
    );
    expect(error.message).toBe("Sidecar request failed (500)");
  });

  it.each(["", "   ", "null", "{}"])(
    "uses a fallback when the body has no message (%s)",
    async (body) => {
      const error = await decode(new Response(body, { status: 500 }));
      expect(error.message).toBe("Sidecar request failed (500)");
      expect(error.status).toBe(500);
    },
  );
});

describe("private sidecar transcription errors", () => {
  const fetchTranscription = (response: Response, signal?: AbortSignal) => {
    secureFetchMock.mockResolvedValueOnce(response);
    const sidecar = new LocalTranscriptionSidecar("cpu") as unknown as {
      fetchJson: (
        url: string,
        init: RequestInit,
        timeout: number,
      ) => Promise<unknown>;
    };
    return sidecar.fetchJson(
      "http://127.0.0.1:1/v1/transcriptions/sessions/s1/chunks",
      { method: "POST", signal },
      1000,
    );
  };

  it("hides transcription fragments from a structured HTTP error while retaining a safe code", async () => {
    const error = await fetchTranscription(
      new Response(
        JSON.stringify({
          error: {
            code: "model_not_downloaded",
            message: "private audio fragment",
          },
        }),
        { status: 404 },
      ),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: "Sidecar request failed (404)",
      status: 404,
      code: "model_not_downloaded",
    });
    expect(String(error)).not.toContain("private audio fragment");
    const sidecar = new LocalTranscriptionSidecar("cpu") as unknown as {
      isModelMissingError: (error: unknown) => boolean;
    };
    expect(sidecar.isModelMissingError(error)).toBe(true);
  });

  it("does not expose an untrusted error code or mistake it for a missing model", async () => {
    const error = await fetchTranscription(
      new Response(
        JSON.stringify({
          error: {
            code: "private code fragment",
            message: "private audio fragment",
          },
        }),
        { status: 404 },
      ),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: "Sidecar request failed (404)",
      status: 404,
      code: "other_sidecar_error",
    });
    expect(JSON.stringify(error)).not.toContain("private");
    const sidecar = new LocalTranscriptionSidecar("cpu") as unknown as {
      isModelMissingError: (error: unknown) => boolean;
    };
    expect(sidecar.isModelMissingError(error)).toBe(false);
  });

  it("preserves non-missing error classification when the message contains credential syntax", async () => {
    const error = await fetchTranscription(
      new Response(
        JSON.stringify({
          error: {
            code: "session_not_found",
            message: "token=private-fragment",
          },
        }),
        { status: 404 },
      ),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ status: 404, code: "other_sidecar_error" });
    const sidecar = new LocalTranscriptionSidecar("cpu") as unknown as {
      isModelMissingError: (error: unknown) => boolean;
    };
    expect(sidecar.isModelMissingError(error)).toBe(false);
  });

  it("does not expose a plain-text transcription error", async () => {
    const error = await fetchTranscription(
      new Response("private audio fragment", { status: 500 }),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: "Sidecar request failed (500)",
      status: 500,
    });
    expect(String(error)).not.toContain("private audio fragment");
  });

  it("does not leak malformed successful JSON", async () => {
    const error = await fetchTranscription(
      new Response("s3cr3t", { status: 200 }),
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("s3cr3t");
  });

  it("preserves the caller's abort reason if JSON decoding fails", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(reason);
      throw new Error("private fragment");
    });
    await expect(fetchTranscription(response, controller.signal)).rejects.toBe(
      reason,
    );
  });
});

describe("local model management", () => {
  it("returns each requested status with the selected validation policy", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    const getStatus = vi
      .spyOn(sidecar, "getModelStatus")
      .mockImplementation(async (model) => ({
        model,
        downloaded: true,
        valid: true,
        fileBytes: 4,
        validationError: null,
      }));
    const result = await sidecar.listModelStatuses(["tiny", "base"], false);
    expect(getStatus).toHaveBeenCalledWith("tiny", false);
    expect(getStatus).toHaveBeenCalledWith("base", false);
    expect(result.tiny.model).toBe("tiny");
    expect(result.base.model).toBe("base");
  });

  it("propagates a status failure instead of returning a partial map", async () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    vi.spyOn(sidecar, "getModelStatus").mockRejectedValueOnce(
      new Error("status failed"),
    );
    await expect(sidecar.listModelStatuses(["tiny"])).rejects.toThrow(
      "status failed",
    );
  });

  it.each([
    {
      action: "pause" as const,
      path: "/v1/models/tiny/download/pause",
      method: "POST",
      clears: false,
    },
    {
      action: "cancel" as const,
      path: "/v1/models/tiny/download/cancel",
      method: "POST",
      clears: true,
    },
    {
      action: "delete" as const,
      path: "/v1/models/tiny",
      method: "DELETE",
      clears: true,
    },
  ])(
    "$action calls its endpoint and updates readiness only after success",
    async ({ action, path, method, clears }) => {
      const sidecar = new LocalTranscriptionSidecar("cpu");
      vi.spyOn(sidecar, "ensureStarted").mockResolvedValue({
        baseUrl: "http://127.0.0.1:1",
      } as Awaited<ReturnType<typeof sidecar.ensureStarted>>);
      const invalidation = vi.spyOn(sidecar, "invalidateModelReadiness");
      const response = { ok: true };
      secureFetchMock.mockResolvedValueOnce(json(response));
      const result =
        action === "pause"
          ? await sidecar.pauseDownload("tiny")
          : action === "cancel"
            ? await sidecar.cancelDownload("tiny")
            : await sidecar.deleteModel("tiny");
      expect(result).toEqual(response);
      expect(secureFetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:1${path}`,
        expect.objectContaining({ method }),
      );
      expect(invalidation).toHaveBeenCalledTimes(clears ? 1 : 0);
      if (clears) expect(invalidation).toHaveBeenCalledWith("tiny");
    },
  );

  it.each(["cancel", "delete"] as const)(
    "does not invalidate readiness when %s fails",
    async (action) => {
      const sidecar = new LocalTranscriptionSidecar("cpu");
      vi.spyOn(sidecar, "ensureStarted").mockResolvedValue({
        baseUrl: "http://127.0.0.1:1",
      } as Awaited<ReturnType<typeof sidecar.ensureStarted>>);
      const invalidation = vi.spyOn(sidecar, "invalidateModelReadiness");
      secureFetchMock.mockResolvedValueOnce(
        new Response("not found", { status: 404 }),
      );
      await expect(
        action === "cancel"
          ? sidecar.cancelDownload("tiny")
          : sidecar.deleteModel("tiny"),
      ).rejects.toThrow("not found");
      expect(invalidation).not.toHaveBeenCalled();
    },
  );
});

describe("sidecar download polling", () => {
  type Snapshot =
    import("./local-transcription.sidecar").LocalSidecarDownloadSnapshot;
  type DownloadInternals = {
    downloadModelInternal: (
      model: "tiny",
      onProgress: (snapshot: Snapshot) => void,
    ) => Promise<Snapshot>;
  };
  const snapshot = (
    status: Snapshot["status"],
    error: string | null = null,
  ): Snapshot => ({
    jobId: "job-1",
    model: "tiny",
    status,
    bytesDownloaded: 10,
    totalBytes: 20,
    progress: 0.5,
    error,
  });
  const setup = () => {
    const sidecar = new LocalTranscriptionSidecar("cpu");
    vi.spyOn(sidecar, "ensureStarted").mockResolvedValue({
      baseUrl: "http://127.0.0.1:1",
    } as Awaited<ReturnType<typeof sidecar.ensureStarted>>);
    return sidecar as unknown as DownloadInternals;
  };

  it.each(["completed", "paused", "canceled"] as const)(
    "reports an immediately %s job without polling",
    async (status) => {
      const sidecar = setup();
      const initial = snapshot(status);
      secureFetchMock.mockResolvedValueOnce(json(initial));
      const onProgress = vi.fn();
      await expect(
        sidecar.downloadModelInternal("tiny", onProgress),
      ).resolves.toEqual(initial);
      expect(onProgress).toHaveBeenCalledExactlyOnceWith(initial);
      expect(secureFetchMock).toHaveBeenCalledOnce();
      expect(secureFetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:1/v1/models/tiny/download",
        expect.objectContaining({ method: "POST" }),
      );
    },
  );

  it.each(["completed", "paused", "canceled"] as const)(
    "polls a running job until it is %s",
    async (status) => {
      const sidecar = setup();
      const initial = snapshot("running");
      const final = snapshot(status);
      secureFetchMock
        .mockResolvedValueOnce(json(initial))
        .mockResolvedValueOnce(json(final));
      const onProgress = vi.fn();
      await expect(
        sidecar.downloadModelInternal("tiny", onProgress),
      ).resolves.toEqual(final);
      expect(onProgress.mock.calls).toEqual([[initial], [final]]);
      expect(secureFetchMock).toHaveBeenLastCalledWith(
        "http://127.0.0.1:1/v1/models/tiny/download/job-1",
        expect.any(Object),
      );
      expect(secureFetchMock.mock.calls.at(-1)?.[1]?.method).toBeUndefined();
    },
  );

  it.each([false, true])(
    "reports a failed job (after polling: %s)",
    async (poll) => {
      const sidecar = setup();
      const failure = snapshot("failed", "download corrupt");
      if (poll)
        secureFetchMock.mockResolvedValueOnce(json(snapshot("running")));
      secureFetchMock.mockResolvedValueOnce(json(failure));
      const onProgress = vi.fn();
      await expect(
        sidecar.downloadModelInternal("tiny", onProgress),
      ).rejects.toThrow("download corrupt");
      expect(onProgress).toHaveBeenLastCalledWith(failure);
    },
  );
});

describe("sidecar request retry policy", () => {
  type Internals = {
    requestJsonByUrl: <T>(
      baseUrl: string,
      path: string,
      options: { retries: number },
    ) => Promise<T>;
  };
  const request = (retries: number) =>
    (
      new LocalTranscriptionSidecar("cpu") as unknown as Internals
    ).requestJsonByUrl<{ ok: boolean }>("http://127.0.0.1:1", "/test", {
      retries,
    });

  it("retries an HTTP 5xx once after the backoff", async () => {
    vi.useFakeTimers();
    try {
      secureFetchMock
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(json({ ok: true }));
      const pending = request(2);
      await vi.advanceTimersByTimeAsync(249);
      expect(secureFetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(secureFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a client error", async () => {
    secureFetchMock.mockResolvedValueOnce(
      new Response("bad request", { status: 400 }),
    );
    await expect(request(2)).rejects.toThrow("bad request");
    expect(secureFetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry a raw transport failure, which may have reached the server", async () => {
    secureFetchMock.mockRejectedValueOnce(new TypeError("network failed"));
    await expect(request(2)).rejects.toThrow("Sidecar transport failed");
    expect(secureFetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry a successful response with invalid JSON", async () => {
    secureFetchMock.mockResolvedValueOnce(new Response("not json"));
    await expect(request(2)).rejects.toThrow();
    expect(secureFetchMock).toHaveBeenCalledOnce();
  });
});

describe("sidecar readiness port", () => {
  const parse = (line: string) =>
    (
      new LocalTranscriptionSidecar("cpu") as unknown as {
        parsePortFromLine: (line: string) => number | null;
      }
    ).parsePortFromLine(line);

  it.each(["", "0", "65536", "-1", "80abc", "80.2", "8e2", "0x80"])(
    "rejects an invalid decimal port %s without probing it",
    (port) => {
      expect(parse(`RUST_TRANSCRIPTION_BOUND_PORT=${port}`)).toBeNull();
    },
  );
  it("accepts a complete valid decimal port", () => {
    expect(parse("RUST_TRANSCRIPTION_BOUND_PORT=1234")).toBe(1234);
  });
});
