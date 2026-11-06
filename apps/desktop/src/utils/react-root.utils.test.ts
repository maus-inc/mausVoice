// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const { createRoot } = vi.hoisted(() => ({ createRoot: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot }));

import { getOrCreateReactRoot } from "./react-root.utils";

describe("getOrCreateReactRoot", () => {
  it("reuses a mount element's root while creating distinct roots for other elements", () => {
    createRoot.mockReset();
    const firstRoot = { render: vi.fn(), unmount: vi.fn() };
    const secondRoot = { render: vi.fn(), unmount: vi.fn() };
    createRoot.mockReturnValueOnce(firstRoot).mockReturnValueOnce(secondRoot);
    const firstElement = document.createElement("div");
    const secondElement = document.createElement("div");

    expect(getOrCreateReactRoot(firstElement)).toBe(firstRoot);
    expect(getOrCreateReactRoot(firstElement)).toBe(firstRoot);
    expect(getOrCreateReactRoot(secondElement)).toBe(secondRoot);
    expect(createRoot).toHaveBeenCalledTimes(2);
    expect(createRoot).toHaveBeenNthCalledWith(1, firstElement);
    expect(createRoot).toHaveBeenNthCalledWith(2, secondElement);
  });
});
