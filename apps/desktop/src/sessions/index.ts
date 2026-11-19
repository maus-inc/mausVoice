import { ApiKeyProvider } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { getAppState } from "../store";
import { TranscriptionSession } from "../types/transcription-session.types";
import { ApiTranscriptionPrefs, TranscriptionPrefs } from "../utils/user.utils";
import { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";
import { AzureTranscriptionSession } from "./azure-transcription-session";
import { BatchTranscriptionSession } from "./batch-transcription-session";
import { DeepgramTranscriptionSession } from "./deepgram-transcription-session";
import { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";
import { GladiaTranscriptionSession } from "./gladia-transcription-session";
import { LocalTranscriptionSession } from "./local-transcription-session";

export { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";
export { AzureTranscriptionSession } from "./azure-transcription-session";
export { BatchTranscriptionSession } from "./batch-transcription-session";
export { DeepgramTranscriptionSession } from "./deepgram-transcription-session";
export { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";
export { GladiaTranscriptionSession } from "./gladia-transcription-session";
export { LocalTranscriptionSession } from "./local-transcription-session";

/**
 * How a session handles the microphone audio, which is the fact the
 * audio-transmission disclosure has to describe.
 *
 * - `local` never leaves the machine.
 * - `live-streaming` uploads chunks while the user is still talking, so audio
 *   already sent cannot be recalled.
 * - `after-stop` records locally and uploads only once recording stops, so a
 *   cancel before that point sends nothing.
 */
export type TranscriptionSessionKind =
  "local" | "live-streaming" | "after-stop";

type CloudTranscriptionPlan = {
  kind: "live-streaming" | "after-stop";
  build: (prefs: ApiTranscriptionPrefs) => TranscriptionSession;
};

const readAzureRegion = (apiKeyId: string): string =>
  getRec(getAppState().apiKeyById, apiKeyId)?.azureRegion || "eastus";

/**
 * Every provider that gets a session class of its own, with the kind that class
 * actually behaves as.
 *
 * The kind lives in the same entry as the constructor on purpose. The
 * disclosure copy and the dispatch path used to be separate lists, so a provider
 * added to one and not the other produced copy that described a session the app
 * never built. Here a provider cannot be made streaming without the constructor
 * that streams, and vice versa.
 *
 * A provider absent from this table is handled by `BatchTranscriptionSession`,
 * which uploads only after recording stops.
 *
 * Note that `AzureTranscriptionSession.supportsStreaming()` returns false even
 * though the session subscribes to `audio_chunk` and sends audio live. The
 * capability method is not the discriminator, which is why the kind is recorded
 * here rather than read back off the built session.
 */
const CLOUD_TRANSCRIPTION_PLANS: Readonly<
  Partial<Record<ApiKeyProvider, CloudTranscriptionPlan>>
> = {
  assemblyai: {
    kind: "live-streaming",
    build: (prefs) => new AssemblyAITranscriptionSession(prefs.apiKeyValue),
  },
  deepgram: {
    kind: "live-streaming",
    build: (prefs) => new DeepgramTranscriptionSession(prefs.apiKeyValue),
  },
  elevenlabs: {
    kind: "live-streaming",
    build: (prefs) => new ElevenLabsTranscriptionSession(prefs.apiKeyValue),
  },
  gladia: {
    kind: "live-streaming",
    build: (prefs) =>
      new GladiaTranscriptionSession(
        prefs.apiKeyValue,
        prefs.transcriptionModel,
      ),
  },
  azure: {
    kind: "live-streaming",
    build: (prefs) =>
      new AzureTranscriptionSession(
        prefs.apiKeyValue,
        readAzureRegion(prefs.apiKeyId),
      ),
  },
};

export const createTranscriptionSession = (
  prefs: TranscriptionPrefs,
): TranscriptionSession => {
  if (prefs.mode === "api") {
    const plan = CLOUD_TRANSCRIPTION_PLANS[prefs.provider];
    if (plan) {
      return plan.build(prefs);
    }
  }

  if (prefs.mode === "local") {
    return new LocalTranscriptionSession();
  }

  return new BatchTranscriptionSession();
};

/**
 * The kind of session a provider and mode produce, read from the same table
 * `createTranscriptionSession` builds its class from.
 *
 * Takes the mode and provider rather than a resolved `TranscriptionPrefs` so the
 * onboarding surface can ask before any key is saved. An unknown or missing
 * provider is treated as `after-stop`, which is what dispatch does with it.
 */
export const resolveTranscriptionSessionKind = (args: {
  mode: "local" | "api";
  provider: ApiKeyProvider | null;
}): TranscriptionSessionKind => {
  if (args.mode === "local") {
    return "local";
  }
  const plan = args.provider
    ? CLOUD_TRANSCRIPTION_PLANS[args.provider]
    : undefined;
  return plan?.kind ?? "after-stop";
};
