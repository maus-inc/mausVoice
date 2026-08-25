export type TranscriptAccumulator = {
  appendFinal: (text: string) => void;
  setPartial: (text: string) => void;
  text: () => string;
  finalLength: () => number;
};

export const createTranscriptAccumulator = (): TranscriptAccumulator => {
  let finalTranscript = "";
  let partialTranscript = "";
  return {
    appendFinal: (text) => {
      finalTranscript = finalTranscript ? `${finalTranscript} ${text}` : text;
    },
    setPartial: (text) => {
      partialTranscript = text;
    },
    text: () =>
      finalTranscript +
      (partialTranscript
        ? (finalTranscript ? " " : "") + partialTranscript
        : ""),
    finalLength: () => finalTranscript.length,
  };
};
