import { describe, expect, it, vi } from "vitest";
import { createWindowListenerGuard } from "./window-listener-guard";

describe("createWindowListenerGuard", () => {
  it("releases an established listener on disposal only once", () => {
    const listener = createWindowListenerGuard();
    const release = vi.fn();
    listener.registered(release);
    expect(listener.isCanceled()).toBe(false);
    listener.dispose();
    listener.dispose();
    expect(listener.isCanceled()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("immediately releases registration that resolves after disposal", () => {
    const listener = createWindowListenerGuard();
    const release = vi.fn();
    listener.dispose();
    listener.registered(release);
    expect(release).toHaveBeenCalledOnce();
  });
});
