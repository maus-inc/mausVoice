// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const { createBrowserRouterMock } = vi.hoisted(() => ({
  createBrowserRouterMock: vi.fn(() => ({})),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  createBrowserRouter: createBrowserRouterMock,
}));

describe("preview router", () => {
  it("does not initialize the unused desktop router alongside the preview router", async () => {
    await import("./PreviewApp");
    expect(createBrowserRouterMock).toHaveBeenCalledTimes(1);

    const { getBrowserRouter } = await import("../router");
    getBrowserRouter();
    getBrowserRouter();
    expect(createBrowserRouterMock).toHaveBeenCalledTimes(2);
  }, 20_000);
});
