import { describe, it, expect } from "vitest";
import {
  buildManualMacInstallerSignatureUrl,
  buildManualMacInstallerUrl,
} from "../../../../packages/desktop-utils/src/updater";

const DMG =
  "https://github.com/maus-inc/mausVoice/releases/download/v1.2.3/mausVoice_1.2.3_universal.dmg";
const EXPECTED_SIG = `${DMG}.sig`;

describe("buildManualMacInstallerSignatureUrl", () => {
  it("derives the signature url as `${dmgUrl}.sig` when no manifest signature exists", () => {
    const rawJson = {
      platforms: { "darwin-x86_64": { url: DMG } },
    };
    expect(buildManualMacInstallerSignatureUrl(rawJson, DMG)).toBe(
      EXPECTED_SIG,
    );
  });

  it("honors a darwin dmgSignatureUrl that names the expected .sig", () => {
    const rawJson = {
      platforms: {
        "darwin-x86_64": { url: DMG, dmgSignatureUrl: EXPECTED_SIG },
      },
    };
    expect(buildManualMacInstallerSignatureUrl(rawJson, DMG)).toBe(
      EXPECTED_SIG,
    );
  });

  it("does NOT blindly return a dmgSignatureUrl from a non-darwin platform", () => {
    const wrongSig = "https://evil.example.com/windows-sig.sig";
    const rawJson = {
      platforms: {
        "windows-x86_64": {
          url: "https://example.com/setup.exe",
          dmgSignatureUrl: wrongSig,
        },
      },
    };
    const result = buildManualMacInstallerSignatureUrl(rawJson, DMG);
    expect(result).toBe(EXPECTED_SIG);
    expect(result).not.toBe(wrongSig);
  });

  it("ignores an empty/blank dmgSignatureUrl and derives the sig", () => {
    const rawJson = {
      platforms: {
        "darwin-x86_64": { url: DMG, dmgSignatureUrl: "" },
      },
    };
    expect(buildManualMacInstallerSignatureUrl(rawJson, DMG)).toBe(
      EXPECTED_SIG,
    );
  });

  it("fails closed (returns null) when the dmg url is missing/invalid", () => {
    expect(
      buildManualMacInstallerSignatureUrl({ platforms: {} }, null),
    ).toBeNull();
    expect(
      buildManualMacInstallerSignatureUrl({ platforms: {} }, ""),
    ).toBeNull();
  });
});

describe("buildManualMacInstallerUrl", () => {
  it("returns null when no release tag can be extracted", () => {
    expect(buildManualMacInstallerUrl("1.0.0", { platforms: {} })).toBeNull();
  });

  it("builds the universal dmg url from the release tag", () => {
    const rawJson = {
      platforms: { "darwin-x86_64": { url: DMG } },
    };
    expect(buildManualMacInstallerUrl("1.2.3", rawJson)).toBe(DMG);
  });
});
