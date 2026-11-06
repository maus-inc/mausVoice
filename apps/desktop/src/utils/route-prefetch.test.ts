// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createRouteLoader } from "./route-prefetch";
it("shares the same import between prefetch and navigation", async () => {
  const Component = () => null;
  const load = vi.fn(async () => ({ default: Component }));
  const warmed: string[] = [];
  const onPrefetch = (event: Event) => {
    warmed.push((event as CustomEvent<string>).detail);
  };
  globalThis.addEventListener("maus:route-prefetch", onPrefetch);
  try {
    const route = createRouteLoader("/test-route", load);
    const pending = route();
    expect(route()).toBe(pending);
    expect(await pending).toEqual({ Component });
    await route();
    expect(load).toHaveBeenCalledTimes(1);
    expect(warmed).toEqual(["/test-route"]);
  } finally {
    globalThis.removeEventListener("maus:route-prefetch", onPrefetch);
  }
});
it("does not poison navigation after a failed prefetch", async () => {
  const Component = () => null;
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ default: Component });
  const route = createRouteLoader("/test-route", load);
  await expect(route()).rejects.toThrow("offline");
  expect(await route()).toEqual({ Component });
  expect(load).toHaveBeenCalledTimes(2);
});
it("retries a failed navigation through the installed data router", async () => {
  const { createMemoryRouter } = await import("react-router-dom");
  const Component = () => null;
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ default: Component });
  const router = createMemoryRouter([
    { path: "/", Component },
    { path: "/destination", lazy: createRouteLoader("/test-route", load) },
  ]);
  try {
    await router.navigate("/destination");
    expect(router.state.errors).not.toBeNull();
    await router.navigate("/");
    await router.navigate("/destination");
    expect(router.state.errors).toBeNull();
    expect(router.state.matches.at(-1)?.route).toEqual(
      expect.objectContaining({
        element: expect.objectContaining({ type: Component }),
      }),
    );
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    router.dispose();
  }
});
