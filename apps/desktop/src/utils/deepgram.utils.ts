export const buildDeepgramWebSocketUrl = (args: {
  sampleRate: number;
  language?: string;
}): string => {
  const params = new URLSearchParams({
    encoding: "linear16",
    sample_rate: String(args.sampleRate),
    model: "nova-3",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
  });

  // "auto" (or unset) → Deepgram nova-3 multilingual code-switching. Note: the
  // `multi` set is English, Spanish, French, German, Hindi, Russian, Portuguese,
  // Japanese, Italian, Dutch — it does NOT include Chinese. For Chinese, a
  // specific language code (e.g. "zh") must be selected.
  params.set(
    "language",
    args.language && args.language !== "auto" ? args.language : "multi",
  );

  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
};
