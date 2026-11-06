import { HttpError } from "@maus-inc/utilities";
import { describe, expect, it, vi } from "vitest";
import {
  assertPrivateProviderResponseOk,
  assertProviderIntegrationOk,
  parsePrivateProviderJson,
  requestAbortableTransport,
  requestPrivateTransport,
  requestSensitiveTransport,
} from "./provider-response.utils";

describe("abortable provider transport", () => {
  it("does not dispatch a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort(null);
    const transport = vi.fn<typeof fetch>();
    await expect(
      requestAbortableTransport(
        "https://example.com",
        { signal: controller.signal },
        transport,
      ),
    ).rejects.toBe(null);
    expect(transport).not.toHaveBeenCalled();
  });

  it("cancels a response if the transport aborts synchronously", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const response = new Response("private");
    const cancel = vi.spyOn(response.body!, "cancel");
    const transport = vi.fn<typeof fetch>(() => {
      controller.abort(reason);
      return Promise.resolve(response);
    });
    await expect(
      requestAbortableTransport(
        "https://example.com",
        { signal: controller.signal },
        transport,
      ),
    ).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("prioritizes cancellation over a synchronous transport throw", async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>(() => {
      controller.abort(null);
      throw new Error("private transport failure");
    });
    await expect(
      requestAbortableTransport(
        "https://example.com",
        { signal: controller.signal },
        transport,
      ),
    ).rejects.toBe(null);
  });

  it("observes a late rejection after cancellation", async () => {
    const controller = new AbortController();
    let reject!: (error: unknown) => void;
    const transport = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((_, fail) => {
          reject = fail;
        }),
    );
    const pending = requestAbortableTransport(
      "https://example.com",
      { signal: controller.signal },
      transport,
    );
    controller.abort(null);
    await expect(pending).rejects.toBe(null);
    reject(new Error("late transport failure"));
    await Promise.resolve();
  });

  it("fails closed when a private transport error has a throwing name accessor", async () => {
    const error = new Error("unused");
    Object.defineProperty(error, "name", {
      get() {
        throw new Error("private accessor fragment");
      },
    });
    const transport = vi.fn<typeof fetch>().mockRejectedValue(error);
    const result = await requestPrivateTransport(
      "https://example.com",
      undefined,
      transport,
      "Provider",
      "Unable to connect",
    ).catch((caught: unknown) => caught);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toBe("Error: Unable to connect");
  });

  it.each([null, "1"])(
    "keeps an HTTP transport retry hint %s without its private message",
    async (hint) => {
      const original = new HttpError(503, "private failure", {
        retryAfter: hint,
      });
      const transport = vi.fn<typeof fetch>().mockRejectedValue(original);
      const error = await requestSensitiveTransport(
        "https://example.com",
        undefined,
        transport,
        "Provider",
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 503,
        retryAfterMs: original.retryAfterMs,
      });
      expect(String(error)).not.toContain("private failure");
    },
  );

  it("retains a plain numeric status on a sanitized failure", async () => {
    const original = Object.assign(new Error("private"), { status: 401 });
    const transport = vi.fn<typeof fetch>().mockRejectedValue(original);
    const error = await requestSensitiveTransport(
      "https://example.com",
      undefined,
      transport,
      "Provider",
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 401 });
    expect(String(error)).not.toContain("private");
  });

  it("retains a terminal status when a custom sanitizer throws", async () => {
    const original = new HttpError(401, "private failure", {
      retryAfter: "1",
    });
    const transport = vi.fn<typeof fetch>().mockRejectedValue(original);
    const error = await requestSensitiveTransport(
      "https://example.com",
      undefined,
      transport,
      "Provider",
      () => {
        throw new Error("private sanitizer failure");
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 401, retryAfterMs: 1000 });
    expect(String(error)).not.toContain("private");
  });

  it("retains a terminal status if the retry hint cannot be read", async () => {
    const original = new HttpError(401, "private failure");
    Object.defineProperty(original, "retryAfterMs", {
      get() {
        throw new Error("private accessor fragment");
      },
    });
    const transport = vi.fn<typeof fetch>().mockRejectedValue(original);
    const error = await requestSensitiveTransport(
      "https://example.com",
      undefined,
      transport,
      "Provider",
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 401 });
    expect(String(error)).not.toContain("private");
  });

  it("leaves a returned response under caller ownership", async () => {
    const controller = new AbortController();
    const response = new Response("ready");
    const cancel = vi.spyOn(response.body!, "cancel");
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await requestAbortableTransport(
      "https://example.com",
      { signal: controller.signal },
      transport,
    );
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
    await expect(result.text()).resolves.toBe("ready");
  });

  it("preserves an immediate transport rejection when not cancelled", async () => {
    const failure = new Error("network failure");
    const transport = vi.fn<typeof fetch>(() => {
      throw failure;
    });
    await expect(
      requestAbortableTransport("https://example.com", undefined, transport),
    ).rejects.toBe(failure);
  });
});

describe("assertProviderIntegrationOk", () => {
  it("leaves a successful response body unread", async () => {
    const response = new Response("success", { status: 200 });
    await expect(
      assertProviderIntegrationOk(response, "Provider"),
    ).resolves.toBeUndefined();
    expect(await response.text()).toBe("success");
  });

  it("retains the status, error detail and retry hint", async () => {
    const response = new Response("busy", {
      status: 503,
      headers: { "retry-after": "2" },
    });
    try {
      await assertProviderIntegrationOk(response, "Provider");
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 503,
        retryAfterMs: 2000,
        message: "Provider responded 503: busy",
      });
    }
  });

  it("handles unreadable error bodies", async () => {
    const response = new Response("busy", { status: 400 });
    await response.text();
    await expect(
      assertProviderIntegrationOk(response, "Provider"),
    ).rejects.toThrow("Provider responded with status 400");
  });
});

describe("provider response privacy and bounds", () => {
  it("redacts the actual request credential and labelled secrets from provider error details", async () => {
    const response = new Response(
      "Token opaque-credential-123; api_key=second-secret; diagnostic: denied",
      { status: 401 },
    );
    const error = await assertProviderIntegrationOk(response, "Provider", [
      "opaque-credential-123",
    ]).then(
      () => {
        throw new Error("expected rejection");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(String(error)).not.toMatch(/opaque-credential-123|second-secret/);
    expect((error as Error).message).toContain("diagnostic: denied");
  });

  it("redacts bare token query parameters in provider diagnostics", async () => {
    const response = new Response(
      "Endpoint: https://example.com/?token=private-fragment; diagnostic: denied",
      { status: 401 },
    );
    const error = await assertProviderIntegrationOk(response, "Provider").catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(String(error)).not.toContain("private-fragment");
    expect(String(error)).toContain("diagnostic: denied");
  });

  it("redacts qualified camelCase labels in provider diagnostics", async () => {
    const label = ["openai", "Api", "Key"].join("");
    const response = new Response(
      `${label}: fragment-example; diagnostic: denied`,
      { status: 401 },
    );
    await expect(
      assertProviderIntegrationOk(response, "Provider"),
    ).rejects.toThrow(
      `Provider responded 401: ${label}:[redacted]; diagnostic: denied`,
    );
  });

  it("omits a diagnostic that would make label redaction take quadratic time", async () => {
    const response = new Response(`${"auth ".repeat(512)}field: hidden`, {
      status: 503,
    });
    await expect(
      assertProviderIntegrationOk(response, "Provider"),
    ).rejects.toThrow("Provider responded 503: [redacted]");
  });

  it("redacts JSON-escaped and URL-encoded forms of a known credential", async () => {
    const secret = 'private "credential"/value';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const encoded = encodeURIComponent(secret);
    const response = new Response(`escaped: ${escaped}, encoded: ${encoded}`, {
      status: 401,
    });
    const error = await assertProviderIntegrationOk(response, "Provider", [
      secret,
    ]).then(
      () => {
        throw new Error("expected rejection");
      },
      (reason: unknown) => reason,
    );
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(escaped);
    expect(String(error)).not.toContain(encoded);
  });

  it("limits excessive empty chunks even when the byte count stays small", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls < 5_000) controller.enqueue(new Uint8Array());
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      assertProviderIntegrationOk(
        new Response(stream, { status: 503 }),
        "Provider",
      ),
    ).rejects.toThrow("Provider responded with status 503");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(5_000);
  });

  it("bounds a stalled error body and cancels the stream", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      });
      const result = assertProviderIntegrationOk(
        new Response(stream, { status: 503 }),
        "Provider",
      ).then(
        () => "resolved",
        (reason: unknown) => String(reason),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        await Promise.race([result, Promise.resolve("still pending")]),
      ).toContain("Provider responded with status 503");
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain a partial detail or wait for cancellation when an error body exceeds the limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("x".repeat(32_768) + "secret-tail"),
        );
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const result = assertProviderIntegrationOk(
      new Response(stream, { status: 503 }),
      "Provider",
    ).then(
      () => "resolved",
      (reason: unknown) => String(reason),
    );
    const outcome = await Promise.race([
      result,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed out"), 250),
      ),
    ]);
    expect(outcome).toContain("Provider responded with status 503");
    expect(outcome).not.toContain("secret-tail");
    expect(outcome.length).toBeLessThan(200);
    expect(cancelled).toBe(true);
  });
});

describe("private provider responses", () => {
  it("keeps a successful response body readable", async () => {
    const response = new Response("audio", { status: 200 });
    assertPrivateProviderResponseOk(response, "TTS failed");
    expect(await response.text()).toBe("audio");
  });

  it("keeps retry metadata while discarding a sensitive error stream", () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const response = new Response(body, {
      status: 429,
      headers: { "retry-after": "2" },
    });
    try {
      assertPrivateProviderResponseOk(response, "TTS failed");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({
        name: "HttpError",
        status: 429,
        retryAfterMs: 2_000,
        message: "TTS failed 429",
      });
    }
    expect(cancelled).toBe(true);
  });
});

describe("private provider JSON", () => {
  it("does not read an already cancelled response", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before parsing");
    controller.abort(reason);
    const response = new Response("private");
    const cancel = vi.spyOn(response.body!, "cancel");
    await expect(
      parsePrivateProviderJson(response, "Aldea", controller.signal),
    ).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops waiting for JSON when an uncooperative body ignores cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled while reading");
    const response = new Response("private");
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const pending = parsePrivateProviderJson(
      response,
      "Aldea",
      controller.signal,
    );
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    controller.abort(reason);
    const result = await Promise.race([
      outcome,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("stalled"), 100),
      ),
    ]);
    expect(result).toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the underlying provider body when an in-flight read is aborted", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = parsePrivateProviderJson(
      response,
      "Aldea",
      controller.signal,
    );
    controller.abort(null);
    await expect(pending).rejects.toBe(null);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("honors caller cancellation after a successful body read", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during parsing");
    const response = new Response("{}");
    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(reason);
      return { text: "private transcript" };
    });
    await expect(
      parsePrivateProviderJson(response, "Aldea", controller.signal),
    ).rejects.toBe(reason);
  });

  it("preserves caller cancellation instead of relabeling it a decode error", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const response = new Response("unused");
    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(reason);
      throw new Error("provider payload fragment");
    });
    await expect(
      parsePrivateProviderJson(response, "Aldea", controller.signal),
    ).rejects.toBe(reason);
  });
});
