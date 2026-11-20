import { describe, expect, it, vi } from "vitest";
import {
  acquireLocalBrowserRecording,
  acquireLocalNativeRecording,
  releaseLocalBrowserRecording,
  releaseLocalNativeRecording,
} from "./local-recording-activity";

describe("local recording activity", () => {
  it("waits for every native lease before admitting browser recognition", () => {
    const invoke = vi.fn(async () => undefined);
    const first = {};
    const second = {};
    const browser = {};
    expect(acquireLocalNativeRecording(invoke, first)).toBe(true);
    expect(acquireLocalNativeRecording(invoke, second)).toBe(true);
    expect(acquireLocalBrowserRecording(invoke, browser)).toBe(false);
    releaseLocalNativeRecording(invoke, first);
    expect(acquireLocalBrowserRecording(invoke, browser)).toBe(false);
    releaseLocalNativeRecording(invoke, second);
    expect(acquireLocalBrowserRecording(invoke, browser)).toBe(true);
    releaseLocalBrowserRecording(invoke, browser);
  });

  it("does not let a stale browser owner release its successor", () => {
    const invoke = vi.fn(async () => undefined);
    const first = {};
    const second = {};
    expect(acquireLocalBrowserRecording(invoke, first)).toBe(true);
    releaseLocalBrowserRecording(invoke, first);
    expect(acquireLocalBrowserRecording(invoke, second)).toBe(true);
    releaseLocalBrowserRecording(invoke, first);
    expect(acquireLocalNativeRecording(invoke, {})).toBe(false);
    releaseLocalBrowserRecording(invoke, second);
    expect(acquireLocalNativeRecording(invoke, {})).toBe(true);
  });

  it("keeps separate transports isolated", () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const browser = {};
    expect(acquireLocalBrowserRecording(first, browser)).toBe(true);
    expect(acquireLocalNativeRecording(second, {})).toBe(true);
    releaseLocalBrowserRecording(first, browser);
  });
});
