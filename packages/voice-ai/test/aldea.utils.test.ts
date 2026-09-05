import { createAldeaTranscribeTests } from "../src/test-helpers/shared-aldea-transcribe.helper";

createAldeaTranscribeTests({
  describeName: "aldeaTranscribeAudio",
  loadModule: async () => {
    const mod = await import("../src/aldea.utils");
    return mod;
  },
  functionName: "aldeaTranscribeAudio",
});
