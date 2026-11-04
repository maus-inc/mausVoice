import { createAsyncMutationTracker } from "./async-mutation-tracker";

// Offset reads must restart if a new row can shift the pages underneath them.
const tracker = createAsyncMutationTracker();
export const trackTranscriptionCreation = tracker.track;
export const waitForTranscriptionCreations = tracker.wait;
export const transcriptionCreationRevision = tracker.revision;
