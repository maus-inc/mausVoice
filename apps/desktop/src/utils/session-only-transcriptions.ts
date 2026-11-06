/**
 * Ids of transcription records that exist only in the session state. The
 * incognito audio import writes a memory row the repository never sees, and
 * the visible-list refresh replaces `transcriptionIds` from the repository,
 * so it consults this registry to keep those rows listed for as long as the
 * state holds them. A delete removes the record from the state, and the
 * refresh drops any registry id that is no longer there, so no explicit
 * unmark is needed.
 */
const sessionOnlyTranscriptionIds = new Set<string>();

export const markTranscriptionSessionOnly = (id: string): void => {
  sessionOnlyTranscriptionIds.add(id);
};

export const getSessionOnlyTranscriptionIds = (): string[] => [
  ...sessionOnlyTranscriptionIds,
];
