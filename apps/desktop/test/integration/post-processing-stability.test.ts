import { expect, test, vi } from "vitest";
import {
  getGroqGentextRepo,
  getWritingStyle,
  postProcess,
  postProcessResolution,
} from "../helpers/eval.utils";
import { withTimeout } from "../../src/utils/timeout.utils";

vi.mock("../../src/i18n/intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/i18n/intl")>();
  return {
    ...actual,
    getIntl: () => ({
      formatMessage: (descriptor: { defaultMessage: string }) =>
        descriptor.defaultMessage,
    }),
  };
});

test("an unusable reply delivers the raw transcript, not a successful cleanup", async () => {
  const generateText = vi.fn().mockResolvedValue({ text: "not JSON" });
  const input = {
    transcription: "Um, keep this.",
    tone: getWritingStyle("default"),
    repo: { generateText },
  };
  expect(await postProcessResolution(input)).toMatchObject({
    status: "unusable",
    reason: "unparseable",
  });
  expect(await postProcess(input)).toBe(input.transcription);
});

test("applies a usable edit to the input instead of delivering the fallback", async () => {
  const repo = {
    generateText: async () => ({
      text: JSON.stringify({
        edits: [{ find: "Um, ", replace: "" }],
        result: "",
      }),
    }),
  };
  const input = {
    transcription: "Um, keep this.",
    tone: getWritingStyle("default"),
    repo,
  };
  expect(await postProcessResolution(input)).toMatchObject({
    status: "cleaned",
    transcript: "keep this.",
  });
  expect(await postProcess(input)).toBe("keep this.");
});

// This is the credentialed, long-input stability check. Once started, a
// rejected request or a partial run is a failure, not a skip or a success.
test.skipIf(!process.env.GROQ_API_KEY)(
  "cleans a long dictation on three successive requests",
  async () => {
    const transcription =
      "Hey, I need you to make it so on the settings page you see that manage subscription button. That should only show up if you're not on trial. Like, it should only show up if you're truly on the pro plan and not a trial. I think there's some utilities that you can use for that. Use your utilities, remember utilities, I believe. So yeah, that should only show up if you're on trial. If you're on trial, I still want to show up with an upgrade button, but I want it to be basically, let me say pay for pro. So you pay for pro, you come up with the vocabulary for that, but it's technically still on pro plan. What I want to do is basically, yeah, so if you're on pro plan, you're still on trial, so what I want it to do is you can click a button, and it should be in the header, and it should be on the settings page, replacing a manage subscription button. And what you should do is when you click on it, it should basically take you to the payment flow where you're going to convert to a real Pro account, you need to update this tribe services. Now come back. To accommodate this tribe service when you subscribe needs to says on trial to false and it only needs to mark your trial as it basically. You're effectively finishing your trial and converting to a real pro user. And yeah, so basically just like a way to get it out of a trial and convert over to a real pro user. I need you to come up with a vocabulary for that.";
    const repo = getGroqGentextRepo();
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const result = await withTimeout(
        postProcessResolution({
          repo,
          signal: controller.signal,
          tone: getWritingStyle("default"),
          transcription,
        }),
        45_000,
        "Groq post-processing stability request",
        () => controller.abort(),
      );
      expect(result.status).toBe("cleaned");
      if (result.status === "cleaned") {
        expect(result.transcript.trim()).not.toBe(transcription);
        expect(result.transcript).toMatch(/trial/i);
        expect(result.transcript).toMatch(/subscription|subscrib|upgrad/i);
      }
    }
  },
  150_000,
);
