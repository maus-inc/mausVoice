import type { Transcription } from "@maus-inc/types";
import dayjs from "dayjs";
import { getTranscriptionRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { createId } from "../utils/id.utils";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import {
  type LocalDataWriteLease,
  assertLocalDataWriteLease,
  beginLocalDataWrite,
  isLocalDataClearRequested,
} from "../utils/local-data-write-gate";
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

const storeRemoteTranscription = async (
  lease: LocalDataWriteLease,
  {
    senderDeviceId,
    rawTranscript,
    transcript,
  }: {
    senderDeviceId: string;
    rawTranscript: string;
    transcript: string;
  },
): Promise<void> => {
  const state = getAppState();
  if (!isPersistenceAllowed()) {
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

  const stored = await getTranscriptionRepo().createTranscription(
    transcription,
    lease,
  );
  produceAppState((draft) => {
    draft.transcriptionById[stored.id] = stored;
    draft.transcriptions.transcriptionIds = [
      stored.id,
      ...draft.transcriptions.transcriptionIds.filter((id) => id !== stored.id),
    ];
  }, lease);
};

export const handleRemoteFinalTextReceived = async (
  payload: RemoteFinalTextReceivedPayload,
  existingLease?: LocalDataWriteLease,
): Promise<boolean> => {
  const finalText = payload.text.trim();
  if (!finalText) {
    return false;
  }

  const ownedWrite = existingLease ? undefined : beginLocalDataWrite();
  const lease = existingLease ?? ownedWrite?.lease;
  if (!lease) return false;

  try {
    assertLocalDataWriteLease(lease);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (isLocalDataClearRequested()) return false;
    await insertLocalTranscriptOutputViaPaste(`${finalText} `, null);
    if (isLocalDataClearRequested()) return false;
    await storeRemoteTranscription(lease, {
      senderDeviceId: payload.senderDeviceId,
      rawTranscript: finalText,
      transcript: finalText,
    }).catch((error) => {
      getLogger().warning(`Failed to store remote transcript: ${error}`);
    });
    if (isLocalDataClearRequested()) return false;

    showSnackbar("Remote transcript inserted.", { mode: "success" });
    return true;
  } finally {
    ownedWrite?.();
  }
};
