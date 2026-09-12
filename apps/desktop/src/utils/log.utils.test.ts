import { describe, expect, it } from "vitest";
import { redactQueryParamValues } from "./log.utils";

describe("redactQueryParamValues", () => {
  it("redacts every occurrence of the named parameters", () => {
    expect(
      redactQueryParamValues(
        "wss://api.deepgram.com/v1/listen?model=nova-3&keyterm=Soniya&keyterm=Kubernetes",
        ["keyterm"],
      ),
    ).toBe(
      "wss://api.deepgram.com/v1/listen?model=nova-3&keyterm=***&keyterm=***",
    );
  });

  it("redacts auth tokens and keyterms together", () => {
    expect(
      redactQueryParamValues(
        "wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=secret&keyterms=Soniya",
        ["token", "keyterms"],
      ),
    ).toBe(
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=***&keyterms=***",
    );
  });

  it("returns the input unchanged when it is not a parseable URL", () => {
    expect(redactQueryParamValues("not a url", ["keyterm"])).toBe("not a url");
  });
});
