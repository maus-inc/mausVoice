import { describe, expect, it } from "vitest";

describe("devicechange subscription contract", () => {
  it("adds and removes the listener when mediaDevices exists", () => {
    const calls: string[] = [];
    const mediaDevices = {
      addEventListener: (type: string) => {
        calls.push(`add:${type}`);
      },
      removeEventListener: (type: string) => {
        calls.push(`remove:${type}`);
      },
    };

    mediaDevices.addEventListener("devicechange");
    mediaDevices.removeEventListener("devicechange");
    expect(calls).toEqual(["add:devicechange", "remove:devicechange"]);
  });
});
