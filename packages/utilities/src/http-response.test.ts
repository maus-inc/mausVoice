import { describe, expect, it, vi } from "vitest";
import {
  discardResponseBody,
  readAbortableResponseArrayBuffer,
  readAbortableResponseJson,
} from "./http-response";

describe("abortable response JSON", () => {
  it("leaves successful results intact", async () => {
    const response = new Response('{"value":1}');
    await expect(readAbortableResponseJson(response)).resolves.toEqual({
      value: 1,
    });
  });

  it("does not read a body after a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(null);
    const response = new Response("private");
    const reading = vi.spyOn(response, "json");
    const cancel = vi.spyOn(response.body!, "cancel");
    await expect(
      readAbortableResponseJson(response, controller.signal),
    ).rejects.toBe(null);
    expect(reading).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("discards without waiting when a stalled read is cancelled", async () => {
    const controller = new AbortController();
    const response = new Response("private");
    vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
    const cancel = vi
      .spyOn(response.body!, "cancel")
      .mockReturnValue(new Promise(() => {}));
    const pending = readAbortableResponseJson(response, controller.signal);
    controller.abort(null);
    await expect(pending).rejects.toBe(null);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the underlying source of a real stalled response body", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = readAbortableResponseJson(response, controller.signal);
    controller.abort(null);
    await expect(pending).rejects.toBe(null);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("decodes a split UTF-8 byte order mark and split multibyte characters", async () => {
    const bytes = new TextEncoder().encode('\ufeff{"value":"é😀"}');
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const response = new Response(
      new ReadableStream({
        start(stream) {
          for (const chunk of chunks) stream.enqueue(chunk);
          stream.close();
        },
      }),
    );
    await expect(
      readAbortableResponseJson(response, new AbortController().signal),
    ).resolves.toEqual({ value: "é😀" });
    expect(response.bodyUsed).toBe(true);
  });

  it("rejects malformed JSON and already consumed or locked bodies", async () => {
    const signal = new AbortController().signal;
    await expect(
      readAbortableResponseJson(new Response("not-json"), signal),
    ).rejects.toBeInstanceOf(SyntaxError);
    await expect(
      readAbortableResponseJson(new Response(null), signal),
    ).rejects.toBeInstanceOf(SyntaxError);
    const used = new Response("{}");
    await used.text();
    await expect(
      readAbortableResponseJson(used, signal),
    ).rejects.toBeInstanceOf(TypeError);
    const locked = new Response("{}");
    const reader = locked.body!.getReader();
    try {
      await expect(
        readAbortableResponseJson(locked, signal),
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      reader.releaseLock();
    }
  });

  it("preserves a response stream error without relabeling it", async () => {
    const failure = new Error("stream broke");
    const response = new Response(
      new ReadableStream({
        pull(stream) {
          stream.error(failure);
        },
      }),
    );
    await expect(
      readAbortableResponseJson(response, new AbortController().signal),
    ).rejects.toBe(failure);
  });

  it("does not wait for an uncooperative underlying cancel callback", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }));
    const pending = readAbortableResponseJson(response, controller.signal);
    controller.abort("stop");
    await expect(pending).rejects.toBe("stop");
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves a JSON read failure when the caller did not cancel", async () => {
    const response = new Response("private");
    const failure = new Error("bad JSON");
    vi.spyOn(response, "json").mockRejectedValue(failure);
    await expect(readAbortableResponseJson(response)).rejects.toBe(failure);
  });

  it("still reads JSON when TransformStream is unavailable", async () => {
    vi.stubGlobal("TransformStream", undefined);
    try {
      await expect(
        readAbortableResponseJson(
          new Response('{"value":1}'),
          new AbortController().signal,
        ),
      ).resolves.toEqual({ value: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not propagate a synchronous body-cancellation failure", () => {
    const response = new Response("unused");
    vi.spyOn(response.body!, "cancel").mockImplementation(() => {
      throw new Error("locked");
    });
    expect(() => discardResponseBody(response)).not.toThrow();
  });
});

describe("abortable response bytes", () => {
  it("returns all bytes unchanged with an active signal", async () => {
    const bytes = Uint8Array.of(0, 255, 13, 128);
    const response = new Response(bytes);
    const result = await readAbortableResponseArrayBuffer(
      response,
      new AbortController().signal,
    );
    expect([...new Uint8Array(result)]).toEqual([...bytes]);
    expect(response.bodyUsed).toBe(true);
  });

  it("cancels a real stalled body without waiting for its source", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }));
    const pending = readAbortableResponseArrayBuffer(
      response,
      controller.signal,
    );
    controller.abort(null);
    await expect(pending).rejects.toBe(null);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps custom body readers and their errors intact", async () => {
    const response = new Response("unused");
    const error = new Error("custom reader failed");
    const read = vi.spyOn(response, "arrayBuffer").mockRejectedValue(error);
    await expect(
      readAbortableResponseArrayBuffer(response, new AbortController().signal),
    ).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
  });
});
