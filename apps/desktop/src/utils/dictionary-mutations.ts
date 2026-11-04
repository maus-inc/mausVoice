import { createAsyncMutationTracker } from "./async-mutation-tracker";

// A list read must not replace optimistic edits with an older database view.
const tracker = createAsyncMutationTracker();
export const dictionaryMutationRevision = tracker.revision;
export const trackDictionaryMutation = tracker.track;
export const waitForDictionaryMutations = tracker.wait;
