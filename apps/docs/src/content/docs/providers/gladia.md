---
title: "Gladia"
description: "Configure Gladia Solaria transcription, live output, language and dictionary hints, limits, and remote cleanup."
sidebar:
  order: 5
---

Gladia is a transcription-only provider in mausVoice. It supports both live microphone streaming and pre-recorded audio, including **History → Import audio** and retranscription.

## Set up a key

1. Create an account and API key using [Gladia's getting-started guide](https://docs.gladia.io/chapters/introduction/getting-started).
2. Open **Settings → Processing → AI transcription**.
3. Add a named API key, choose **Gladia**, enter the secret, and save it.
4. Select `solaria-1`, then use **Test**.

The credential test makes `GET /v2/pre-recorded?limit=1` with your key. It checks authentication without creating a transcription job. It does not prove quota, concurrency, language support, or future live connectivity. mausVoice currently exposes only `solaria-1`. If an older profile contains another Gladia model value, transcription uses `solaria-1` and adds a warning to the History result.

## Live dictation

The live session sends mono, little-endian 16-bit PCM over Gladia's secure WebSocket. Supported microphone rates are passed through; another capture rate is converted with a stateful streaming resampler. mausVoice registers its audio listener before network initialization and keeps a bounded startup buffer so opening the session does not silently lose the first words or grow memory without limit.

Only finalized Gladia utterances enter [real-time output](../../using-mausvoice/real-time-output/). Partial revisions stay internal, finalized utterance IDs are emitted once, and the authoritative post-final transcript wins when Gladia returns one. Startup and reconnect behavior uses bounded SDK retries. The temporary WebSocket endpoint must be on `wss://api.gladia.io`; token-bearing URLs are never written to application logs.

Gladia documents a three-hour live-session maximum. mausVoice warns one minute before and automatically stops at 179 minutes, leaving safety margin before the provider cutoff. This provider-owned timer uses wall-clock time from microphone start and continues while dictation is paused, even if the optional user dictation timer is disabled or restarted.

## Pre-recorded audio

Batch transcription follows this sequence:

1. upload a WAV file;
2. create the asynchronous transcription with `solaria-1`;
3. poll to completion;
4. extract the full transcript (or assembled utterances);
5. request deletion of the transcription job in `finally` cleanup.

Long recordings are split into 60-minute chunks with five seconds of overlap and at most three concurrent requests. The overlap is removed while results are merged. This stays below Gladia's documented per-file pre-recorded limit; check [current formats and limits](https://docs.gladia.io/chapters/limits-and-specifications/supported-formats) before relying on a provider limit.

## Languages and dictionary

With language **Auto**, mausVoice sends an empty language list and disables code switching so Gladia detects one language. An explicit locale such as `en-US` or `pt-BR` maps to its base code (`en`, `pt`). Cantonese locale code `yue` maps to Gladia's Chinese code `zh`. Check [Gladia's current supported-language list](https://docs.gladia.io/chapters/language/supported-languages) if a locale fails.

Dictionary data has two distinct provider hints:

- canonical terms become Gladia custom-vocabulary entries to bias recognition;
- replacement sources become custom-spelling variants keyed by their destination, such as `MausVoice: ["mouse voice"]`.

mausVoice trims, sanitizes, case-deduplicates, and bounds these payloads. A warning is attached if entries exceed the safe budget. The ordinary local replacement pass still runs after transcription, so provider hints improve recognition but do not replace mausVoice's deterministic dictionary behavior.

## Deletion, retention, and billing

After live or batch completion, mausVoice requests deletion through Gladia's provider-specific V2 endpoint. A deletion failure does **not** erase a successful transcript: the text is retained locally according to your History settings and a cleanup warning is attached. Deletion is best effort, not a zero-retention guarantee.

There is one unavoidable upload/create boundary. If file upload succeeds but job creation fails before Gladia returns a transcription ID, mausVoice has no job ID it can send to the deletion endpoint. That upload remains subject to Gladia's own retention process. Aborting a live connection during initialization has a similar race if no session ID was issued.

Provider retention, free-plan data use/model-training terms, prices, credits, and concurrency can change independently of the app. In particular, do not assume a free plan has the same privacy or training terms as a paid or enterprise plan. Review Gladia's [data-retention documentation](https://docs.gladia.io/chapters/limits-and-specifications/data-retention), [security page](https://www.gladia.io/security), and [current pricing](https://www.gladia.io/pricing) before sending confidential audio. Use Local transcription when audio must not leave the device.
