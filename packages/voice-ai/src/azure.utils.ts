import * as sdk from "microsoft-cognitiveservices-speech-sdk";

export type AzureTranscriptionArgs = {
  subscriptionKey: string;
  region: string;
  blob: ArrayBuffer | Buffer;
  language?: string;
  /** Vocabulary terms fed to the recognizer's phrase list. */
  phrases?: string[];
};

export type AzureTranscribeAudioOutput = {
  text: string;
};

const AZURE_LOCALE_REGEX = /^[a-z]{2,3}-[A-Z]{2}$/;

const applyPhraseList = (
  recognizer: sdk.SpeechRecognizer,
  phrases: string[] | undefined,
): void => {
  if (!phrases || phrases.length === 0) return;
  // The phrase list takes plain terms and supports multi-word phrases, so
  // the caller passes vocabulary terms directly and never a prompt sentence,
  // whose instruction words would bias recognition.
  const phraseListGrammar = sdk.PhraseListGrammar.fromRecognizer(recognizer);
  phrases
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0)
    .forEach((phrase) => phraseListGrammar.addPhrase(phrase));
};

const mapToAzureLocale = (language?: string): string => {
  if (!language || language.trim() === "") {
    return "en-US";
  }

  const trimmedLanguage = language.trim();

  if (trimmedLanguage.includes("-")) {
    if (AZURE_LOCALE_REGEX.test(trimmedLanguage)) {
      return trimmedLanguage;
    }
    const baseLang = trimmedLanguage.split("-")[0];
    if (baseLang) {
      return mapToAzureLocale(baseLang);
    }
  }

  const languageMap: Record<string, string> = {
    en: "en-US",
    es: "es-ES",
    fr: "fr-FR",
    de: "de-DE",
    it: "it-IT",
    pt: "pt-PT",
    ru: "ru-RU",
    ja: "ja-JP",
    ko: "ko-KR",
    zh: "zh-CN",
    ar: "ar-SA",
    nl: "nl-NL",
    sv: "sv-SE",
    tr: "tr-TR",
    pl: "pl-PL",
    ca: "ca-ES",
    id: "id-ID",
    hi: "hi-IN",
    fi: "fi-FI",
    vi: "vi-VN",
    he: "he-IL",
    uk: "uk-UA",
    el: "el-GR",
    ms: "ms-MY",
    cs: "cs-CZ",
    ro: "ro-RO",
    da: "da-DK",
    hu: "hu-HU",
    ta: "ta-IN",
    no: "nb-NO",
    th: "th-TH",
    ur: "ur-PK",
    hr: "hr-HR",
    bg: "bg-BG",
    lt: "lt-LT",
    sk: "sk-SK",
    sl: "sl-SI",
    et: "et-EE",
    lv: "lv-LV",
    fa: "fa-IR",
    sr: "sr-RS",
    bn: "bn-IN",
    af: "af-ZA",
    hy: "hy-AM",
    az: "az-AZ",
    eu: "eu-ES",
    bs: "bs-BA",
    gl: "gl-ES",
    gu: "gu-IN",
    is: "is-IS",
    kk: "kk-KZ",
    kn: "kn-IN",
    km: "km-KH",
    lo: "lo-LA",
    mk: "mk-MK",
    ml: "ml-IN",
    mr: "mr-IN",
    mn: "mn-MN",
    ne: "ne-NP",
    ps: "ps-AF",
    si: "si-LK",
    sw: "sw-KE",
    te: "te-IN",
    uz: "uz-UZ",
    cy: "cy-GB",
    am: "am-ET",
    ka: "ka-GE",
    my: "my-MM",
    so: "so-SO",
    sq: "sq-AL",
  };

  return languageMap[trimmedLanguage] || "en-US";
};

export const azureTranscribeAudio = async ({
  subscriptionKey,
  region,
  blob,
  language = "en-US",
  phrases,
}: AzureTranscriptionArgs): Promise<AzureTranscribeAudioOutput> => {
  return new Promise((resolve, reject) => {
    const azureLocale = mapToAzureLocale(language);
    const trimmedRegion = region.trim();
    const trimmedKey = subscriptionKey.trim();

    const speechConfig = sdk.SpeechConfig.fromSubscription(
      trimmedKey,
      trimmedRegion,
    );
    speechConfig.speechRecognitionLanguage = azureLocale;

    const audioBuffer =
      blob instanceof ArrayBuffer ? blob : (blob.buffer as ArrayBuffer);

    const dataView = new DataView(audioBuffer);
    const sampleRate = dataView.getUint32(24, true);
    const bitsPerSample = dataView.getUint16(34, true);
    const channels = dataView.getUint16(22, true);

    const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(
      sampleRate,
      bitsPerSample,
      channels,
    );
    const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);

    const uint8Array = new Uint8Array(audioBuffer);
    const wavHeaderSize = 44;
    const audioData = uint8Array.slice(wavHeaderSize);

    pushStream.write(audioData.buffer);
    pushStream.close();

    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    applyPhraseList(recognizer, phrases);

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();

        if (result.reason === sdk.ResultReason.RecognizedSpeech) {
          resolve({ text: result.text });
        } else if (result.reason === sdk.ResultReason.NoMatch) {
          resolve({ text: "" });
        } else {
          reject(new Error(`Azure recognition failed: ${result.errorDetails}`));
        }
      },
      (error) => {
        recognizer.close();
        reject(new Error(`Azure API request failed: ${error}`));
      },
    );
  });
};

export type AzureTestIntegrationArgs = {
  subscriptionKey: string;
  region: string;
};

/** Bytes in a canonical 44-byte PCM WAV header. */
const WAV_HEADER_BYTES = 44;
const PROBE_SAMPLE_RATE = 16_000;
const PROBE_CHANNELS = 1;
const PROBE_BITS_PER_SAMPLE = 16;
/** 0.3s of frames, long enough for the service to run one recognition turn. */
const PROBE_FRAMES = 4_800;

/**
 * A real silent WAV file. The probe used to hand the recognizer a 0-byte
 * buffer, which made `azureTranscribeAudio` throw a `RangeError` while reading
 * the sample rate out of the header, so the probe never reached Azure and
 * reported success for every key. The PCM payload stays zeroed, which is
 * genuine silence and comes back as a completed `NoMatch`.
 */
const buildSilentWav = (): ArrayBuffer => {
  const bytesPerSample = PROBE_BITS_PER_SAMPLE / 8;
  const blockAlign = PROBE_CHANNELS * bytesPerSample;
  const dataBytes = PROBE_FRAMES * blockAlign;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeTag = (offset: number, tag: string) => {
    for (let index = 0; index < tag.length; index++) {
      view.setUint8(offset + index, tag.charCodeAt(index));
    }
  };

  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // chunk size after the RIFF header
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, PROBE_CHANNELS, true);
  view.setUint32(24, PROBE_SAMPLE_RATE, true);
  view.setUint32(28, PROBE_SAMPLE_RATE * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PROBE_BITS_PER_SAMPLE, true);
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);

  return buffer;
};

export const azureTestIntegration = async ({
  subscriptionKey,
  region,
}: AzureTestIntegrationArgs): Promise<boolean> => {
  try {
    await azureTranscribeAudio({
      subscriptionKey,
      region,
      blob: buildSilentWav(),
    });
    return true;
  } catch {
    // Fail closed. The recognizer reports a failure through
    // `err?: (e: string) => void`, so the reason only ever arrives as prose
    // whose wording differs per transport: a blank region produces "You must
    // specify the Cognitive Speech region to use.", a rejected credential
    // produces a handshake or service message, and a locally malformed buffer
    // produces a RangeError. Deciding by substring matched almost none of
    // them and reported a working key for a dead one. Only a recognition round
    // trip that actually completed proves the credentials work.
    return false;
  }
};

export type AzureStreamingSession = {
  writeAudioChunk: (chunk: Float32Array) => void;
  finalize: () => Promise<string>;
  cleanup: () => void;
};

export type CreateAzureStreamingSessionArgs = {
  subscriptionKey: string;
  region: string;
  sampleRate: number;
  language?: string;
  /** Vocabulary terms fed to the recognizer's phrase list. */
  phrases?: string[];
};

export const createAzureStreamingSession = async ({
  subscriptionKey,
  region,
  sampleRate,
  language,
  phrases,
}: CreateAzureStreamingSessionArgs): Promise<AzureStreamingSession> => {
  return new Promise((resolve, reject) => {
    const azureLocale = mapToAzureLocale(language);
    const trimmedRegion = region.trim();
    const trimmedKey = subscriptionKey.trim();

    const speechConfig = sdk.SpeechConfig.fromSubscription(
      trimmedKey,
      trimmedRegion,
    );
    speechConfig.speechRecognitionLanguage = azureLocale;

    const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(
      sampleRate,
      16,
      1,
    );
    const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    applyPhraseList(recognizer, phrases);

    let fullTranscript = "";
    let isFinalized = false;

    recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
        fullTranscript += (fullTranscript ? " " : "") + e.result.text;
        console.log(
          "[Azure Streaming] Recognized segment, length:",
          e.result.text.length,
        );
      } else if (e.result.reason === sdk.ResultReason.NoMatch) {
        console.log("[Azure Streaming] No speech recognized in segment");
      }
    };

    recognizer.recognizing = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizingSpeech) {
        console.log(
          "[Azure Streaming] Recognizing, length:",
          e.result.text.length,
        );
      }
    };

    recognizer.canceled = (_s, e) => {
      console.error("[Azure Streaming] Recognition canceled:", e.errorDetails);
      if (e.reason === sdk.CancellationReason.Error) {
        console.error("[Azure Streaming] Error code:", e.errorCode);
      }
    };

    recognizer.sessionStarted = () => {
      console.log("[Azure Streaming] Session started");
    };

    recognizer.sessionStopped = () => {
      console.log("[Azure Streaming] Session stopped");
    };

    recognizer.startContinuousRecognitionAsync(
      () => {
        console.log("[Azure Streaming] Continuous recognition started");

        const writeAudioChunk = (chunk: Float32Array) => {
          if (isFinalized) {
            console.warn(
              "[Azure Streaming] Attempted to write chunk after finalization",
            );
            return;
          }

          const pcm16Buffer = new ArrayBuffer(chunk.length * 2);
          const pcm16View = new Int16Array(pcm16Buffer);

          for (let i = 0; i < chunk.length; i++) {
            const s = Math.max(-1, Math.min(1, chunk[i] ?? 0));
            pcm16View[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }

          pushStream.write(pcm16Buffer);
        };

        const finalize = (): Promise<string> => {
          return new Promise((resolveFinalize) => {
            if (isFinalized) {
              console.log(
                "[Azure Streaming] Already finalized, returning transcript",
              );
              resolveFinalize(fullTranscript);
              return;
            }

            isFinalized = true;
            console.log("[Azure Streaming] Finalizing session...");

            pushStream.close();

            const timeout = setTimeout(() => {
              console.log(
                "[Azure Streaming] Timeout reached, finalizing with transcript length:",
                fullTranscript.length,
              );
              recognizer.close();
              resolveFinalize(fullTranscript);
            }, 2000);

            recognizer.stopContinuousRecognitionAsync(
              () => {
                clearTimeout(timeout);
                console.log(
                  "[Azure Streaming] Recognition stopped, final transcript length:",
                  fullTranscript.length,
                );
                recognizer.close();
                resolveFinalize(fullTranscript);
              },
              (error) => {
                clearTimeout(timeout);
                console.error(
                  "[Azure Streaming] Error stopping recognition:",
                  error,
                );
                recognizer.close();
                resolveFinalize(fullTranscript);
              },
            );
          });
        };

        const cleanup = () => {
          if (!isFinalized) {
            pushStream.close();
            recognizer.close();
          }
        };

        resolve({
          writeAudioChunk,
          finalize,
          cleanup,
        });
      },
      (error) => {
        console.error("[Azure Streaming] Failed to start recognition:", error);
        recognizer.close();
        reject(new Error(`Failed to start Azure recognition: ${error}`));
      },
    );
  });
};
