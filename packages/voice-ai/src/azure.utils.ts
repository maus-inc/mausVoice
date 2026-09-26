import { unknownToMessage } from "@maus-inc/utilities";
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

/**
 * A failure from the Azure recognizer, with the SDK's own reason kept beside
 * the message.
 *
 * The recognizer reports a failure as prose only: its public one-shot API is
 * `recognizeOnceAsync(cb, err?: (e: string) => void)`, and a failed handshake
 * is rejected as the raw string built in the SDK's `ServiceRecognizerBase`
 * ("Unable to contact server. StatusCode: 401, <endpoint> Reason: ..."). There
 * is no structured error to read, so the reason is carried as data here and
 * the credential probe classifies it instead of guessing from the message.
 */
export class AzureRecognitionError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "AzureRecognitionError";
    this.reason = reason;
  }
}

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
          reject(
            new AzureRecognitionError(
              `Azure recognition failed: ${result.errorDetails}`,
              result.errorDetails,
            ),
          );
        }
      },
      (error) => {
        recognizer.close();
        reject(
          new AzureRecognitionError(
            `Azure API request failed: ${error}`,
            error,
          ),
        );
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
 * Write a WAV chunk id. The field is four ASCII bytes, so a code point above
 * U+007F cannot be encoded at all. `for...of` walks code points rather than
 * UTF-16 code units, so an astral character arrives here whole and is rejected
 * instead of being written as two low bytes, which would corrupt the id for
 * every reader of the file.
 */
export const writeWavChunkId = (
  view: DataView,
  offset: number,
  tag: string,
): void => {
  let index = 0;
  for (const character of tag) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint > 0x7f) {
      throw new RangeError(
        `A WAV chunk id is ASCII, so "${tag}" cannot be written at offset ${offset}.`,
      );
    }
    view.setUint8(offset + index, codePoint);
    index += 1;
  }
};

/**
 * A real silent WAV file. The probe used to hand the recognizer a 0-byte
 * buffer, which made `azureTranscribeAudio` throw a `RangeError` while reading
 * the sample rate out of the header, so the probe never reached Azure and
 * reported success for every key. The PCM payload stays zeroed, which is
 * genuine silence and comes back as a completed `NoMatch`.
 */
export const buildSilentProbeWav = (): ArrayBuffer => {
  const bytesPerSample = PROBE_BITS_PER_SAMPLE / 8;
  const blockAlign = PROBE_CHANNELS * bytesPerSample;
  const dataBytes = PROBE_FRAMES * blockAlign;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeWavChunkId(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // chunk size after the RIFF header
  writeWavChunkId(view, 8, "WAVE");
  writeWavChunkId(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, PROBE_CHANNELS, true);
  view.setUint32(24, PROBE_SAMPLE_RATE, true);
  view.setUint32(28, PROBE_SAMPLE_RATE * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PROBE_BITS_PER_SAMPLE, true);
  writeWavChunkId(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  return buffer;
};

/**
 * What the probe can tell apart from the SDK's prose. Only a rejected
 * credential is a reason to report "provide a valid API key"; every other
 * outcome has a different fix, so it carries its own message instead.
 */
type AzureProbeFailure =
  "credential" | "region" | "quota" | "unreachable" | "unknown";

/** The handshake status the SDK embeds in its own failure message. */
const AZURE_STATUS_CODE = /StatusCode:\s*(\d+)/i;

const CREDENTIAL_STATUS_CODES = new Set([400, 401, 403]);
const REGION_STATUS_CODES = new Set([404]);
const QUOTA_STATUS_CODES = new Set([429]);
/** The SDK reports 0 when the socket never reached the service at all. */
const UNREACHABLE_STATUS_CODES = new Set([0]);

const matchesAny = (reason: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(reason));

/**
 * The SDK's own text for a key it refuses, quoted from
 * `microsoft-cognitiveservices-speech-sdk` 1.51.0.
 * `SpeechConfig.fromSubscription` calls
 * `Contracts.throwIfNullOrWhitespace(subscriptionKey, "subscriptionKey")`,
 * which throws `"throwIfNullOrWhitespace:subscriptionKey"` before any request
 * leaves the process. That is the message a whitespace-only key produces here,
 * and it carries no status, no "authentication", and no "key" wording that the
 * keyword rules around it would catch, so it needs a pattern of its own.
 */
const BLANK_KEY_PATTERN =
  /throwIfNullOr(?:Whitespace|Undefined):\s*subscriptionKey/i;

/**
 * Classify the reason the SDK handed over. The status code inside the SDK's
 * own message is the strongest signal it offers, so it is read first; the
 * keyword rules cover the SDK's local validation messages and the service body
 * on a REST rejection, which carry no status of their own.
 *
 * A rule here has to match something no earlier rule matches, because the list
 * is scanned in order and every entry returns the same classification. The SDK
 * twin of the region message,
 * `RestConfigBase.privRestErrors.authInvalidSubscriptionKey` ("You must specify
 * either an authentication token to use, or a Cognitive Speech subscription
 * key."), is the reason `/authentication/i` is in the list; it needs no
 * pattern of its own, and adding one would be dead weight.
 */
const classifyAzureProbeFailure = (reason: string): AzureProbeFailure => {
  const statusCode = AZURE_STATUS_CODE.exec(reason)?.[1];
  if (statusCode !== undefined) {
    const status = Number(statusCode);
    if (CREDENTIAL_STATUS_CODES.has(status)) return "credential";
    if (REGION_STATUS_CODES.has(status)) return "region";
    if (QUOTA_STATUS_CODES.has(status)) return "quota";
    if (UNREACHABLE_STATUS_CODES.has(status)) return "unreachable";
  }
  if (
    matchesAny(reason, [
      BLANK_KEY_PATTERN,
      /invalid subscription key/i,
      /access denied/i,
      /authentication/i,
      /\bunauthorized\b/i,
    ])
  ) {
    return "credential";
  }
  if (matchesAny(reason, [/\bregion\b/i, /resource not found/i])) {
    return "region";
  }
  if (matchesAny(reason, [/\bquota\b/i, /exhausted/i, /rate limit/i])) {
    return "quota";
  }
  if (
    matchesAny(reason, [
      /unable to contact/i,
      /\bnetwork\b/i,
      /econnrefused/i,
      /getaddrinfo/i,
      /timed?\s?out/i,
      /enotfound/i,
    ])
  ) {
    return "unreachable";
  }
  return "unknown";
};

const describeAzureProbeFailure = (
  failure: Exclude<AzureProbeFailure, "credential">,
  region: string,
): string => {
  switch (failure) {
    case "region":
      return `Azure rejected the region "${region}". Use the region of the Speech resource, not the one the key was copied from.`;
    case "quota":
      return "Azure accepted the key but the subscription has no quota left. Raise the quota or wait for it to reset.";
    case "unreachable":
      return "Azure could not be reached from this machine. Check the network and any proxy or firewall.";
    case "unknown":
      return "Azure could not confirm the key.";
  }
};

const readAzureReason = (error: unknown): string => {
  if (error instanceof AzureRecognitionError) {
    return error.reason;
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * How much of the SDK's own prose rides along in the message the settings
 * screen puts in a snackbar. `ApiKeyList` hands `error.message` straight to
 * `showErrorSnackbar`, which is `String(message)` with no cap of its own, and a
 * handshake rejection embeds a full web-services error document. The diagnosis
 * sentence carries the action; the excerpt only helps a user who recognises
 * their own key or region in it.
 */
const AZURE_REASON_EXCERPT_CHARS = 120;

/**
 * Redacts credential-shaped values out of text this app does not control.
 *
 * The reason is third-party prose: a gateway or proxy can echo the key it was
 * given, and the excerpt that carries it is shown in two places, the webview
 * console handed to the native log sink, whose rolled file the user attaches to
 * a diagnostics export, and the settings snackbar. That sink's sanitizer only
 * knows the labels this app writes itself, so nothing downstream would remove a
 * token that arrived inside someone else's sentence.
 *
 * `unknownToMessage` runs before this and covers the shapes it knows, a Bearer
 * token, its own list of labels, and a provider-prefixed token. What arrives
 * here is what it missed: a gateway header it has no label for, a value with no
 * provider prefix, and a token that carries no label at all.
 *
 * The match is deliberately loose on the value and strict on the label, because
 * a false positive costs a diagnosis and a false negative publishes a key. The
 * label may be quoted, because an error body or a gateway echo arrives as JSON,
 * where a closing quote sits between the label and the separator.
 *
 * Every quantifier here is bounded on purpose. The reason is text a remote end
 * chose, so a pattern with two adjacent unbounded whitespace runs would let it
 * choose input that backtracks, and a trailing boundary after a greedy run
 * makes the engine retry every shorter length. Bounded runs and no trailing
 * boundary keep this linear on hostile input, which the ReDoS case below pins.
 */
const AZURE_CREDENTIAL_PATTERNS: RegExp[] = [
  // A labelled credential: `Ocp-Apim-Subscription-Key: v`, `api_key=v`,
  // `{"access_token":"v"}`, `x-api-key: v` and so on. Matching the shape of the
  // label rather than listing names keeps this one quantifier pair instead of
  // five nested alternations, and it also catches names nobody enumerated, such
  // as `client_secret` or `x-amz-security-token`.
  //
  // It over-matches on purpose: any label merely ENDING in one of those words
  // is redacted whatever follows it, so `monkey=5` is redacted too. The text
  // reaching this is an Azure failure reason, where no such field exists, and a
  // redaction control that hides one harmless value is far cheaper than one that
  // lets a key through because a new vendor prefix was not enumerated.
  /\b[a-z0-9_.-]{0,24}(?:key|token|secret|password|credential)\b["']{0,2}[ \t]{0,4}[:=][ \t]{0,4}["']{0,2}\S+/gi,
  // `Authorization: Bearer <value>`, `{"authorization":"<value>"}`, any scheme.
  /\bauthorization\b["']{0,2}[ \t]{0,4}[:=][ \t]{0,4}["']{0,2}(?:(?:bearer|basic|token)[ \t]{0,4})?\S+/gi,
  // A bare provider-style token, wherever it appears.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  // A JWT, which is long and structurally unmistakable. Its whole body is
  // base64url plus the two dots, so one class covers every segment and the
  // length is what makes it distinctive.
  /\beyJ[A-Za-z0-9_.-]{20,}/g,
];

const redactCredentialShapedText = (text: string): string =>
  AZURE_CREDENTIAL_PATTERNS.reduce(
    (redacted, pattern) =>
      redacted.replace(pattern, (match) => {
        // A quoted label leaves its closing quote in front of the separator, so
        // the label is cut before that quote and the separator is kept as it
        // was written, which leaves a readable `label: [redacted]`. The quote
        // run is bounded because a label is a handful of characters at most.
        const separator = match.search(/[:=]/);
        if (separator === -1) return "[redacted]";
        const label = match.slice(0, separator).replace(/["']{1,2}$/, "");
        return `${label}${match[separator]} [redacted]`;
      }),
    text,
  );

/**
 * One bounded, single-line excerpt of the SDK's reason, safe to put in front of
 * a user. Redaction runs before the bound, so a credential is never present to
 * be cut in half, and the remainder keeps the status code, endpoint and wording
 * the diagnosis is read from. The reason arrives as multi-line service prose, so
 * the whitespace is collapsed before the cut lands on a word boundary.
 */
const azureReasonExcerpt = (reason: string, limit: number): string => {
  const flattened = redactCredentialShapedText(unknownToMessage(reason))
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length <= limit) {
    return flattened;
  }
  const truncated = flattened.slice(0, limit);
  const lastSpace = truncated.lastIndexOf(" ");
  const body =
    lastSpace > limit / 2 ? truncated.slice(0, lastSpace) : truncated;
  return `${body.trimEnd()}…`;
};

/**
 * The budget for the excerpt that goes to the log, which is longer than the
 * snackbar's because the log is read to answer a support request rather than at
 * a glance, and it keeps the redacted markers that show a credential was
 * present.
 *
 * Both ends of the range come from the reasons the tests in this file log. The
 * lower end is the fully redacted gateway reason, 209 characters, so a bound
 * under 209 cuts that record and drops the markers, which is the only thing the
 * log line is there for. The upper end is the cap the bounds test puts on the
 * logged record, under 600 characters, and an excerpt is its bound plus at most
 * one ellipsis, so the bound stays at 598 or below. The value below sits just
 * above the lower end and well under the upper one.
 */
const AZURE_REASON_LOG_CHARS = 240;

export const azureTestIntegration = async ({
  subscriptionKey,
  region,
}: AzureTestIntegrationArgs): Promise<boolean> => {
  try {
    await azureTranscribeAudio({
      subscriptionKey,
      region,
      blob: buildSilentProbeWav(),
    });
    return true;
  } catch (error) {
    // Fail closed, but do not mislabel. Only a completed recognition round trip
    // proves the credentials work, and the reason decides what the caller is
    // told: a rejected credential returns false, because that is the one
    // outcome where "provide a valid API key" is the right advice. Every other
    // outcome is raised with a redacted, single-line, capped excerpt of the
    // reason, because ApiKeyList hands that message to showErrorSnackbar, and
    // the same excerpt with a longer budget goes to the log for support.
    const reason = readAzureReason(error);
    const failure = classifyAzureProbeFailure(reason);
    if (failure === "credential") {
      return false;
    }
    console.error(
      "Azure integration probe failed:",
      azureReasonExcerpt(reason, AZURE_REASON_LOG_CHARS),
    );
    throw new Error(
      `${describeAzureProbeFailure(failure, region)} Azure reported: ${azureReasonExcerpt(reason, AZURE_REASON_EXCERPT_CHARS)}`,
    );
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
