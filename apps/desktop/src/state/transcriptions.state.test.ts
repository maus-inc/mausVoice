import { describe, expect, it } from "vitest";
import {
  beginRetranscribe,
  clearRetranscribeSuccess,
  didRetranscribeSucceed,
  finishRetranscribe,
  INITIAL_TRANSCRIPTIONS_STATE,
  isRetranscribingId,
  type TranscriptionsState,
} from "./transcriptions.state";

const fresh = (): TranscriptionsState =>
  structuredClone(INITIAL_TRANSCRIPTIONS_STATE);

describe("retranscribe state helpers", () => {
  it("moves a row in-flight -> success -> cleared", () => {
    const state = fresh();

    beginRetranscribe(state, "a");
    expect(isRetranscribingId(state, "a")).toBe(true);
    expect(didRetranscribeSucceed(state, "a")).toBe(false);

    finishRetranscribe(state, "a", true);
    expect(isRetranscribingId(state, "a")).toBe(false);
    expect(didRetranscribeSucceed(state, "a")).toBe(true);

    clearRetranscribeSuccess(state, "a");
    expect(isRetranscribingId(state, "a")).toBe(false);
    expect(didRetranscribeSucceed(state, "a")).toBe(false);
  });

  it("clears a prior success when the same row starts again", () => {
    const state = fresh();
    beginRetranscribe(state, "a");
    finishRetranscribe(state, "a", true);
    expect(didRetranscribeSucceed(state, "a")).toBe(true);

    beginRetranscribe(state, "a");
    expect(isRetranscribingId(state, "a")).toBe(true);
    expect(didRetranscribeSucceed(state, "a")).toBe(false);
  });

  it("keeps the row enabled after an error (no success flash)", () => {
    const state = fresh();
    beginRetranscribe(state, "a");
    finishRetranscribe(state, "a", false);

    expect(isRetranscribingId(state, "a")).toBe(false);
    expect(didRetranscribeSucceed(state, "a")).toBe(false);
  });

  it("does not let one row clear another row's in-flight or success", () => {
    const state = fresh();
    beginRetranscribe(state, "a");
    beginRetranscribe(state, "b");
    finishRetranscribe(state, "a", true);
    clearRetranscribeSuccess(state, "a");

    expect(isRetranscribingId(state, "a")).toBe(false);
    expect(didRetranscribeSucceed(state, "a")).toBe(false);
    expect(isRetranscribingId(state, "b")).toBe(true);
    expect(didRetranscribeSucceed(state, "b")).toBe(false);
  });

  it("is idempotent when beginning or succeeding the same id twice", () => {
    const state = fresh();
    beginRetranscribe(state, "a");
    beginRetranscribe(state, "a");
    expect(state.retranscribingIds).toEqual(["a"]);

    finishRetranscribe(state, "a", true);
    finishRetranscribe(state, "a", true);
    expect(state.retranscriptionSuccessIds).toEqual(["a"]);
    expect(state.retranscribingIds).toEqual([]);
  });
});
