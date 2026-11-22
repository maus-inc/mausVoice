// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseRemotePairingInvite } from "./remote-pairing.actions";

const INVITE_PREFIX = "mausvoice-pair:";

const encodeInvite = (value: unknown): string => {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${INVITE_PREFIX}${b64}`;
};

const validInvite = {
  version: 1,
  receiverDeviceId: "device-1",
  receiverDeviceName: "Studio Mac",
  receiverPlatform: "macos",
  receiverAddress: "192.168.1.10:47821",
  pairingCode: "428913",
};

describe("parseRemotePairingInvite", () => {
  it("round-trips a valid invite", () => {
    const parsed = parseRemotePairingInvite(encodeInvite(validInvite));
    expect(parsed.receiverDeviceId).toBe("device-1");
    expect(parsed.pairingCode).toBe("428913");
  });

  it("rejects a value without the invite prefix", () => {
    expect(() => parseRemotePairingInvite("not-an-invite")).toThrow(
      "not a valid mausVoice remote invite",
    );
  });

  it("rejects a malformed base64 payload with a friendly message", () => {
    // `!!!` is outside the base64 alphabet, so atob throws a DOMException.
    expect(() => parseRemotePairingInvite(`${INVITE_PREFIX}!!!`)).toThrow(
      "not a valid mausVoice remote invite",
    );
  });

  it("rejects a valid base64 body that is not JSON", () => {
    const b64 = btoa("this is not json")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(() => parseRemotePairingInvite(`${INVITE_PREFIX}${b64}`)).toThrow(
      "not a valid mausVoice remote invite",
    );
  });

  it("rejects JSON that is not an object", () => {
    // A bare number is not an object, so it is rejected as malformed.
    expect(() => parseRemotePairingInvite(encodeInvite(42))).toThrow(
      "not a valid mausVoice remote invite",
    );
  });

  it("rejects an array body as missing receiver information", () => {
    // An array is an object, so it reaches field validation and fails there.
    expect(() => parseRemotePairingInvite(encodeInvite([1, 2, 3]))).toThrow(
      "missing required receiver information",
    );
  });

  it("rejects an invite missing required fields", () => {
    const incomplete = { ...validInvite, pairingCode: "" };
    expect(() => parseRemotePairingInvite(encodeInvite(incomplete))).toThrow(
      "missing required receiver information",
    );
  });

  it("rejects an invite with a future version", () => {
    expect(() =>
      parseRemotePairingInvite(encodeInvite({ ...validInvite, version: 2 })),
    ).toThrow("missing required receiver information");
  });
});
