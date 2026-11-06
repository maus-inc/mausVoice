/**
 * Ids of transcription records that exist only in the session state. The
 * incognito audio import writes a memory row the repository never sees, and
 * the visible-list refresh replaces `transcriptionIds` from the repository,
 * so it consults this registry to keep those rows listed for as long as the
 * state holds them. The refresh also prunes ids whose record left the state,
 * so import-and-delete cycles cannot grow the set without bound.
 */
const sessionOnlyTranscriptionIds = new Set<string>();

export const markTranscriptionSessionOnly = (id: string): void => {
  sessionOnlyTranscriptionIds.add(id);
};

export const unmarkTranscriptionSessionOnly = (id: string): void => {
  sessionOnlyTranscriptionIds.delete(id);
};

export const getSessionOnlyTranscriptionIds = (): string[] => [
  ...sessionOnlyTranscriptionIds,
];
