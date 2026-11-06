import { describe, expect, it } from "vitest";
import { parseReceiverPort } from "./receiver-port.utils";

describe("parseReceiverPort", () => {
  it.each(["", "   "])("uses an automatic port for %j", (input) => {
    expect(parseReceiverPort(input)).toEqual({ valid: true, value: null });
  });
  it.each([
    ["1", 1],
    [" 65535 ", 65535],
    ["1e3", 1000],
    ["0x10", 16],
  ] as const)("accepts %s", (input, value) => {
    expect(parseReceiverPort(input)).toEqual({ valid: true, value });
  });
  it.each([
    "0",
    "-1",
    "1.5",
    "65536",
    "100000000000000000000",
    "Infinity",
    "NaN",
    "abc",
  ])("rejects %s", (input) => {
    expect(parseReceiverPort(input)).toEqual({ valid: false });
  });
});
