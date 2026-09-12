import { describe, expect, it } from "vitest";
import {
  groupWordsIntoSegments,
  type MeetingTimedWord,
} from "./meeting-transcription-session";

const word = (
  text: string,
  startMs: number,
  endMs: number,
  speaker: number | null,
  confidence = 0.9,
): MeetingTimedWord => ({ text, startMs, endMs, speaker, confidence });

describe("groupWordsIntoSegments", () => {
  it("groups consecutive same-speaker words into one segment", () => {
    const { segments, speakers } = groupWordsIntoSegments([
      word("hello", 0, 400, 0),
      word("world", 400, 900, 0),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      speakerId: "speaker-0",
      startTimeMs: 0,
      endTimeMs: 900,
      text: "hello world",
      confidence: 0.9,
    });
    expect(speakers).toEqual([
      { id: "speaker-0", meetingId: "", name: "Speaker 1" },
    ]);
  });

  it("splits segments on speaker change and tracks both speakers", () => {
    const { segments, speakers } = groupWordsIntoSegments([
      word("hi", 0, 300, 0),
      word("hey", 300, 600, 1),
      word("there", 600, 1000, 1),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ speakerId: "speaker-0", text: "hi" });
    expect(segments[1]).toMatchObject({
      speakerId: "speaker-1",
      startTimeMs: 300,
      endTimeMs: 1000,
      text: "hey there",
    });
    expect(speakers.map((s) => s.id)).toEqual(["speaker-0", "speaker-1"]);
  });

  it("collects words without speaker labels under the unknown speaker", () => {
    const { segments, speakers } = groupWordsIntoSegments([
      word("um", 0, 200, null),
      word("well", 200, 500, null),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0].speakerId).toBe("speaker-unknown");
    expect(speakers).toEqual([
      { id: "speaker-unknown", meetingId: "", name: "Unknown speaker" },
    ]);
  });

  it("returns empty segments and speakers for no words", () => {
    expect(groupWordsIntoSegments([])).toEqual({ segments: [], speakers: [] });
  });
});
