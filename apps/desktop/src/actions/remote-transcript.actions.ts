import type { Transcription } from "@maus-inc/types";
import dayjs from "dayjs";
import { getTranscriptionRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { createId } from "../utils/id.utils";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { getLogger } from "../utils/log.utils";
import { insertLocalTranscriptOutputViaPaste } from "../utils/output-routing.utils";
import { getMyEffectiveUserId } from "../utils/user.utils";
import { showSnackbar } from "./app.actions";

export type RemoteFinalTextReceivedPayload = {
  senderDeviceId: string;
  eventId: string;
  text: string;
  mode: string;
  createdAt: string;
};

const storeRemoteTranscription = async ({
  senderDeviceId,
  rawTranscript,
  transcript,
  isCurrent,
}: {
  senderDeviceId: string;
  rawTranscript: string;
  transcript: string;
  isCurrent: () => boolean;
}): Promise<void> => {
  const state = getAppState();
  if (!isCurrent() || !isPersistenceAllowed()) {
    return;
  }

  const transcription: Transcription = {
    id: createId(),
    createdAt: dayjs().toISOString(),
    createdByUserId: getMyEffectiveUserId(state),
    transcript,
    isDeleted: false,
    rawTranscript,
    sanitizedTranscript: rawTranscript,
    modelSize: null,
    inferenceDevice: null,
    transcriptionPrompt: null,
    postProcessPrompt: null,
    transcriptionApiKeyId: null,
    postProcessApiKeyId: null,
    transcriptionMode: null,
    postProcessMode: null,
    postProcessDevice: null,
    postProcessModel: null,
    transcriptionDurationMs: null,
    postprocessDurationMs: null,
    remoteStatus: "received",
    remoteDeviceId: senderDeviceId,
  };

  const stored =
    await getTranscriptionRepo().createTranscription(transcription);
  if (!isCurrent()) return;
  produceAppState((draft) => {
    draft.transcriptionById[stored.id] = stored;
    draft.transcriptions.transcriptionIds = [
      stored.id,
      ...draft.transcriptions.transcriptionIds.filter((id) => id !== stored.id),
    ];
  });
};

export const handleRemoteFinalTextReceived = async (
  payload: RemoteFinalTextReceivedPayload,
  isCurrent: () => boolean = () => true,
): Promise<void> => {
  const finalText = payload.text.trim();
  if (!finalText || !isCurrent()) {
    return;
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  if (!isCurrent()) return;
  await insertLocalTranscriptOutputViaPaste(`${finalText} `, null);
  // Insertion may already be in flight when ownership changes. Do not then
  // attach the old transcript or its success notification to the new account.
  if (!isCurrent()) return;
  await storeRemoteTranscription({
    senderDeviceId: payload.senderDeviceId,
    rawTranscript: finalText,
    transcript: finalText,
    isCurrent,
  }).catch((error) => {
    getLogger().warning(`Failed to store remote transcript: ${error}`);
  });

  if (isCurrent()) {
    showSnackbar("Remote transcript inserted.", { mode: "success" });
  }
};
