export type TranscriptAccumulator = {
  appendFinal: (text: string) => void;
  setPartial: (text: string) => void;
  text: () => string;
  finalLength: () => number;
};

export const createTranscriptAccumulator = (): TranscriptAccumulator => {
  let finalTranscript = "";
  let partialTranscript = "";
  const joinPartial = (): string => {
    if (!partialTranscript) return "";
    return (finalTranscript ? " " : "") + partialTranscript;
  };
  return {
    appendFinal: (text) => {
      finalTranscript = finalTranscript ? `${finalTranscript} ${text}` : text;
    },
    setPartial: (text) => {
      partialTranscript = text;
    },
    text: () => finalTranscript + joinPartial(),
    finalLength: () => finalTranscript.length,
  };
};
