import { describe, expect, it } from "vitest";
import { audioToArrayBuffer } from "./audio-convert.utils";

describe("audioToArrayBuffer", () => {
  it("returns a supplied ArrayBuffer unchanged", () => {
    const audio = new Uint8Array([1, 2, 3]).buffer;
    expect(audioToArrayBuffer(audio)).toBe(audio);
  });

  it("copies only the bytes in a sliced Buffer, excluding the backing pool", () => {
    const storage = Buffer.from([99, 1, 2, 3, 88]);
    const audio = storage.subarray(1, 4);
    const result = audioToArrayBuffer(audio);
    storage[1] = 7;
    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3]);
  });
});
