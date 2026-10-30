# Transcription latency deep dive: from pill stop to inserted text

Scope: everything between the user stopping a dictation (hotkey release or pill click) and the transcript landing in their text box. The goal is a 10x cut in the wait the user sees after they stop, with no feature loss.

This report covers:

1. How the pipeline works today, with file references
2. Measured and modeled costs of each stage
3. A ranked list of every opportunity found, with impact, effort, and risk
4. What this branch implements, and how it was validated
5. A roadmap to reach 10x or better on every provider class, with metrics

All numbers marked "measured" come from Node 22 benchmarks run in this sandbox (x86, 2 vCPU). WebView2 and WebKit run the same V8/JSC class of engines, so treat them as the right order of magnitude, not exact desktop numbers.

## 1. The pipeline today

```
 stop hotkey / pill click
        |
        v
 DictationSideEffects.stopRecording            apps/desktop/src/components/root/DictationSideEffects.tsx
        |
        |  captureStopRecordingInfo: Promise.all waits for the slowest of
        |    - set_phase("loading")
        |    - stop_recording          -> Vec<f32> serialized as a JSON number array
        |    - get_text_field_info     -> accessibility tree walk
        |    - tryRegisterCurrentAppTarget -> app info + icon extraction + icon upload + DB upsert
        v
 finalizeAndPostProcess
        |    - await saveManualStyleForApp (DB write)       <- before transcription starts
        |    - session.finalize(audio, { toneId, a11yInfo }) <- options never read by any session
        v
 session.finalize                                 apps/desktop/src/sessions/*
        |  Batch (Groq, OpenAI, Gemini, xAI, ...):
        |    Array.from -> transcribeAudio -> repo -> buildWaveFile at capture rate (48 kHz)
        |    -> secureFetch -> @tauri-apps/plugin-http
        |         JS: Array.from(new Uint8Array(wav)) -> JSON number array over IPC
        |         Rust: new reqwest::Client per request -> DNS + TCP + TLS every time
        |    -> upload whole recording -> provider inference
        |  Local (whisper.cpp / ONNX sidecar):
        |    chunks streamed to sidecar during recording, but the sidecar only buffers
        |    them; full inference runs at /finalize (packages/rust_transcription/src/api.rs)
        |  Streaming (Deepgram, AssemblyAI, ElevenLabs, Gladia, Azure):
        |    audio already streamed; finalize flushes the socket, but only after the
        |    whole JSON stop_recording payload has crossed IPC
        v
 DictationStrategy.handleTranscript -> optional LLM post-processing -> paste
        v
 storeTranscription (after paste; audio re-sent over IPC as JSON Vec<f64>)
```

Key code locations:

| Stage | Location |
| --- | --- |
| Stop orchestration | `apps/desktop/src/components/root/DictationSideEffects.tsx` `captureStopRecordingInfo`, `finalizeAndPostProcess` |
| Native capture | `apps/desktop/src-tauri/src/platform/audio.rs` (cpal, device native rate, mono downmix, 100 ms `audio_chunk` events) |
| Stop command | `apps/desktop/src-tauri/src/commands.rs` `stop_recording` |
| Session factory | `apps/desktop/src/sessions/index.ts` |
| Batch upload | `apps/desktop/src/repos/transcribe-audio.repo.ts` (13 providers call `buildWaveFile`) |
| HTTP egress | `apps/desktop/src/utils/secure-fetch.utils.ts` -> `@tauri-apps/plugin-http` 2.5.8 |
| Local sidecar | `apps/desktop/src/sidecars/local-transcription.sidecar.ts`, `packages/rust_transcription/src/{api,streaming_sessions,transcription}.rs` |
| Timing marks | `apps/desktop/src/utils/pipeline-trace.ts` (`stopped` -> `audioFinalized` -> `transcribed` -> `inserted`) |

## 2. Where the time goes

### 2.1 Audio handoff over IPC (all providers)

`stop_recording` returned `StopRecordingResponse { samples: Vec<f32> }`. Tauri serializes that to JSON, so every sample becomes text. Measured in this sandbox:

| Recording at 48 kHz | JSON size | JSON.parse in the webview |
| --- | --- | --- |
| 10 s | 5.9 MB | 38 ms |
| 30 s | 17.8 MB | 175 ms |
| 60 s | 35.7 MB | 358 ms |

On top of the parse, Rust has to format 2.9 M floats per minute and the IPC layer has to move 36 MB of text. The Tauri docs say this directly: large return values serialized to JSON slow the app down, and `tauri::ipc::Response` exists to return raw array buffers ([Tauri docs](https://v2.tauri.app/develop/calling-rust/)). A binary body of the same audio decodes in under 0.1 ms (measured, see section 4).

This cost sits in front of every provider, including the streaming ones. Their finalize could not start until the 36 MB payload arrived.

### 2.2 Serial work before transcription starts

`captureStopRecordingInfo` used one `Promise.all` for the audio and the focus context, so transcription waited for the slowest of:

- `get_text_field_info`: accessibility tree query. UIA on Windows and AX on macOS commonly take 20 to 300 ms and can stall on busy apps.
- `tryRegisterCurrentAppTarget`: `get_current_app_info` with a base64 icon, then for new apps an icon upload and a DB upsert.

After that, `saveManualStyleForApp` ran as another awaited DB write before `session.finalize`. None of this output is used by transcription: no session implementation reads the `toneId` or `a11yInfo` finalize options. They only feed post-processing and history.

### 2.3 Upload size and encoding (batch cloud providers)

Every batch repo built a WAV at the capture rate, normally 48 kHz. Groq's docs state its models downsample to 16 kHz mono before transcribing and recommend doing it client side to cut size ([Groq docs](https://console.groq.com/docs/speech-to-text)). Whisper models also run at 16 kHz internally.

| Recording | WAV at 48 kHz | WAV at 16 kHz | Upload at 10 Mbps, 48 kHz vs 16 kHz |
| --- | --- | --- | --- |
| 10 s | 0.96 MB | 0.32 MB | 0.77 s vs 0.26 s |
| 30 s | 2.88 MB | 0.96 MB | 2.3 s vs 0.77 s |
| 60 s | 5.76 MB | 1.92 MB | 4.6 s vs 1.5 s |

The plugin-http JS shim then converts the body with `Array.from(new Uint8Array(buffer))` and sends it as a JSON number array (`dist-js/index.js` line 68; Rust side `ClientConfig.data: Option<Vec<u8>>`). Measured:

| WAV body | IPC JSON | Array.from + stringify | JSON decode |
| --- | --- | --- | --- |
| 60 s at 48 kHz, 5.76 MB | 20.6 MB | 353 ms | ~197 ms |
| 60 s at 16 kHz, 1.92 MB | 6.9 MB | 100 ms | ~50 ms |

### 2.4 No connection reuse

plugin-http builds `reqwest::ClientBuilder::new()...build()` inside every `fetch` command ([source](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/http/src/commands.rs)). A reqwest `Client` owns its connection pool, so each transcription pays DNS, TCP, and a TLS handshake, typically 100 to 400 ms depending on distance to the provider. Another Tauri app hit the same thing and measured one TCP connection per sequential request (Kordi issue #1614). Pre-warming is impossible while the client is thrown away after each request.

### 2.5 Whole-recording batch processing

For batch cloud and local modes, nothing is transcribed until stop. The wait therefore grows linearly with recording length: upload time for cloud, inference time for local. The local sidecar already receives audio chunks live (`POST /sessions/:id/chunks`) but only appends them to a buffer (`streaming_sessions.rs` `append_samples`); `finalize_transcription_session` runs the full `whisper_full` or ONNX pass on all of it.

### 2.6 Smaller items found

- `Array.from` on the sample array in batch and local sessions, then `Float32Array.from` again in the repo: two full copies per stop.
- AssemblyAI batch polling uses a fixed 3 s interval (`packages/voice-ai/src/assemblyai.utils.ts`), adding about 1.5 s on average. Dictation uses the AssemblyAI streaming session, so this hits retranscribe and import only.
- `store_transcription_audio` takes `Vec<f64>` over JSON. It runs after paste, so it doesn't delay the text, but it does hold `isStopping` and delays the next dictation.
- The existing streaming resamplers (`elevenlabs-transcription-session.ts`, `gladia.utils.ts`) interpolate linearly with no anti-alias filter. That is an accuracy issue, not a latency one.
- The macOS/Windows `ChunkEmitter` doesn't flush its last partial 100 ms batch on stop. That is a potential clipped-last-word issue for streaming providers, also not latency.

### 2.7 Modeled end-to-end wait, before this branch

Groq `whisper-large-v3-turbo`, 60 s dictation at 48 kHz, 10 Mbps uplink:

| Stage | Cost |
| --- | --- |
| stop_recording JSON (serialize + transport + 358 ms parse) | ~0.5 to 0.8 s |
| Focus context and style write in front of finalize | 0.05 to 0.5 s |
| WAV build + plugin-http JSON body | ~0.6 s |
| New TLS connection | 0.1 to 0.4 s |
| Upload 5.76 MB | 4.6 s |
| Inference (Groq, estimated) | ~0.4 s |
| **Total** | **~6.3 to 7.3 s** |

## 3. Ranked opportunities

Impact is for the post-stop wait. Effort: S under a day, M a few days, L a week or more.

| # | Opportunity | Impact | Effort | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Pretranscribe at natural pauses during recording (batch cloud + local) | Wait bounded by tail length, not recording length. 5x to 30x on 30 s+ dictations | M | Medium: chunk boundaries. Mitigated by pause-only cuts, prefix verification, full fallback | Done |
| 2 | Binary `stop_recording` via `tauri::ipc::Response` | Removes 0.1 to 0.8 s from every provider, streaming included | S | Low | Done |
| 3 | Upload 16 kHz mono instead of 48 kHz | 3x fewer bytes on every batch request | S | Low: ASR models run at 16 kHz | Done |
| 4 | Start finalize as soon as audio arrives; run a11y, app target, style write in parallel | Removes 0.05 to 0.5 s | S | Low | Done |
| 5 | Remove redundant sample copies | ~10 to 50 ms and 2 x 11 MB allocations per minute | S | Low | Done |
| 6 | Pooled HTTP client for transcription uploads, plus pre-warm at recording start | Removes 0.1 to 0.4 s handshake | M | Medium: new egress command must keep the provider allowlist | Roadmap M2 |
| 7 | Raw binary request body for uploads, no JSON byte array | Removes 0.15 to 0.55 s per minute of audio | M (bundled with 6) | Low | Roadmap M2 |
| 8 | Compressed upload (FLAC lossless, or Opus 24 kbps) | Another 2x (FLAC) to 20x (Opus) fewer bytes | M | Low for FLAC. Opus needs a per-provider accuracy check | Roadmap M3 |
| 9 | Streaming upload: send WAV bytes with chunked transfer encoding while recording | Upload time goes to ~0 for single-request providers | L | Medium: provider support for chunked multipart varies | Roadmap M3 |
| 10 | Sidecar incremental decode (VAD-segmented `whisper_full` on arrival) | Local wait bounded by one segment. Also removes the HTTP hop per span | L | Medium | Roadmap M3 |
| 11 | whisper.cpp built-in Silero VAD (`vad` params) to skip silence before the encoder | 10 to 40% less local compute on pause-heavy speech | S | Low | Roadmap M2 |
| 12 | Default to fastest adequate local model (Parakeet TDT, turbo) and GPU where present | 3x to 10x local inference | S | Low: settings migration only | Roadmap M2 |
| 13 | Binary `audio_chunk` via `tauri::ipc::Channel` | Cuts per-100 ms JSON work during recording; faster streaming sends | M | Low | Roadmap M3 |
| 14 | Faster AssemblyAI batch polling (250 ms, then back off to 3 s) | ~1.3 s for retranscribe and import | S | Low | Roadmap M2 |
| 15 | Binary `store_transcription_audio` | Frees the next dictation sooner, 50 to 300 ms per minute | S | Low | Roadmap M2 |
| 16 | Provider-native realtime APIs for batch-only providers (OpenAI Realtime transcription, Groq streaming when available) | Wait ~ finalize RTT for all lengths | L | Medium: behavior of server VAD and commit | Roadmap M4 |
| 17 | LocalAgreement-style speculative streaming on local Whisper | Interim text while speaking; ~3.3 s lag on GPU per the paper (arXiv 2307.14743) | L | Medium: WER +2% in the paper | Roadmap M4, optional |

Rejected or deferred on purpose:

- Lowering `minChunkSec` below 10 s for cloud providers. Groq bills a 10 s minimum per request, and smaller spans lose context.
- Parallel span requests. Spans finish during speech anyway. Serial order keeps rate limits and local CPU contention in check.
- Moving analytics or `recordStreak` later. They already run off the critical path (`delayed(2000)`, fire-and-forget `trackAppUsed`), and history storage already runs after paste.

## 4. What this branch implements

### 4.1 Binary audio handoff

`stop_recording` now returns `tauri::ipc::Response` with `[sample_rate u32 LE][f32 LE samples]` (`encode_recorded_audio` in `commands.rs`, with a Rust unit test). Specta cannot describe `ipc::Response` ([tauri-specta #158](https://github.com/specta-rs/tauri-specta/issues/158)), so the command is registered in `app.rs` but removed from `gen_bindings.rs` and `bindings.ts`, along with the now-unused `StopRecordingResponse` type.

`apps/desktop/src/utils/recorded-audio.utils.ts` has the single decoder all three callers use: the dictation stop path, the microphone tester, and the composer voice recorder. It takes a zero-copy `Float32Array` view when aligned on a little-endian host and falls back to a `DataView` copy otherwise. It also accepts a `number[]` byte array and the legacy object shape, so the browser preview runtime and existing test doubles keep working.

### 4.2 Transcription starts before the focus context resolves

`captureStopRecordingInfo` now returns the audio plus a `context` promise for the a11y info and app target. `finalizeAndPostProcess` calls `session.finalize(audio)` immediately, then awaits the context, `trackAppUsed`, and the style write while the provider works. The tone resolution and the "style write finishes before the next dictation" guarantee are unchanged; they now overlap with transcription instead of preceding it. The unused `TranscriptionSessionFinalizeOptions` parameter was removed from the session interface.

### 4.3 16 kHz uploads

`apps/desktop/src/utils/speech-resample.utils.ts` is an anti-aliased polyphase windowed-sinc downsampler with a Blackman window, 8 zero crossings, cutoff at 94% of the output Nyquist, and a cached coefficient table per rate pair. `buildSpeechUploadWav` in `audio.utils.ts` replaces `buildWaveFile` in all 13 batch repos. History playback still stores the native-rate audio. Ratios that would need more than 1,024 phases fall back to today's native-rate WAV.

Measured cost: 26 ms for 10 s, 106 ms for 60 s at 48 kHz. With pretranscription only the tail is resampled at stop, typically 30 to 50 ms. Tests confirm a 1 kHz tone passes at full level, a 12 kHz tone is suppressed below -40 dB instead of aliasing, and DC is preserved at the clip edges.

### 4.4 Pause-chunked pretranscription

`apps/desktop/src/sessions/pause-chunked-pretranscriber.ts` listens to the live `audio_chunk` stream the recorder already emits for every mode:

1. It runs a 30 ms frame energy VAD with two trackers. The noise floor falls fast and rises slowly; the speech level rises fast and decays slowly. A frame is silent only if it is below 3x the floor and at least 20 dB under recent speech. The second test keeps a recording that starts mid-sentence, or a long monologue, from being cut mid-word. There is a regression test with 90 s of continuous speech.
2. Once `minChunkSec` of audio is pending and a pause reaches `minPauseMs`, it cuts at the middle of the pause and sends that span through the normal `transcribeAudio` action. Provider dispatch, dictionary prompt, silence gate, and hallucination filtering are the same as a whole-recording request.
3. Spans are transcribed strictly in order, one at a time.
4. At stop, `finish(audio)` seals the instance, checks that every committed span is an exact prefix of the final recording (32-sample probes at each cut), transcribes only the tail, and joins the spans. CJK, Thai, Lao, Khmer, and Burmese join without a space; everything else joins with one space.

It returns `null`, and the session transcribes the whole recording exactly as before, when:

- no cut happened (every dictation shorter than about `minChunkSec`, so short dictations behave exactly as before),
- any span request failed,
- the sample rate differs, or
- the live stream does not match the final recording.

Settings per mode, in `batch-transcription-session.ts`:

| Mode | `minChunkSec` | `minPauseMs` | Reason |
| --- | --- | --- | --- |
| Batch cloud | 12 | 450 | Above Groq's 10 s billing minimum, keeps the tail short |
| Local | 24 | 450 | whisper.cpp pads each call to a 30 s window, so spans near 30 s avoid extra encoder passes |

`LocalTranscriptionSession` feeds one listener to both its existing sidecar stream and the pretranscriber. If pretranscription is unusable, the existing streaming finalize and batch fallback run unchanged. Local spans use `sanitizedTranscript`, which mirrors the no-speech gating of the primary local path; cloud spans use `rawTranscript`, as the batch path did before.

Each pretranscribed stop logs `pretranscribed N spans; post-stop wait X ms`, which is the field metric for section 5.

### 4.5 Validation done here

- `tsc --noEmit`, `oxlint`, `prettier --check`, `ui-lint`: clean.
- Vitest: 1,987 passed, including 24 new tests. The same 54 tests fail before and after this change; they are the eval and integration suites that need `GROQ_API_KEY` and other provider keys.
- Rust: this sandbox cannot reach rustup or apt, so `cargo check` and `cargo test` were not run here. The Rust diff is small (one function, one command signature, one test, one bindings list entry) and CI must confirm it. `check-bindings.sh` will regenerate `bindings.ts`; the hand edit only removes the `stopRecording` entry and its type, which is what Specta emits once the command leaves `collect_commands!`.

### 4.6 Expected effect of this branch

Groq, 10 Mbps uplink, typical speech with a pause every few seconds. After the change, the tail is roughly 12 s plus the time to the next pause.

| Dictation | Before | After this branch | Speedup |
| --- | --- | --- | --- |
| 10 s | ~1.6 s | ~0.8 s | 2x |
| 30 s | ~3.7 s | ~0.9 s | 4x |
| 60 s | ~6.8 s | ~0.9 s | 7.5x |
| 120 s | ~13 s | ~0.9 s | 14x |
| 300 s | ~31 s | ~0.9 s | 30x+ |

After this branch, the remaining ~0.9 s is roughly 0.4 s tail upload, 0.2 s TLS, 0.15 s inference, and ~0.1 s JSON body plus resample. Milestone M2 removes the TLS and JSON body share. For streaming providers, the gain is the removed JSON handoff: 0.1 to 0.8 s off a wait that was often 1 s or less.

For local whisper, the wait after stop drops from the whole recording's inference to one tail window: about 2x to 3x for 60 s and more for longer recordings. ONNX models such as Parakeet scale roughly linearly with audio length, so the gain approaches the recording-to-tail ratio.

## 5. Roadmap to 10x on every path

### M1, this branch

Binary stop handoff, parallel stop context, 16 kHz uploads, pause-chunked pretranscription. 10x or better for batch cloud dictations of 90 s and longer; 2x to 7.5x for 10 to 60 s.

Exit metric: the `transcribed - stopped` pipeline-trace median drops by 4x or more on 30 to 60 s dictations in dogfood logs, with no rise in edit rate or "Transcription failed" toasts.

### M2, transport and local quick wins (1 to 2 weeks)

1. **Transcription upload command with a pooled client.** Add a Rust command, for example `transcription_http_upload`, holding one `reqwest::Client` in app state (pool, keep-alive, HTTP/2 where offered). It takes the body as a raw IPC request (`tauri::ipc::Request` with `InvokeBody::Raw`) and headers via invoke options. Enforce the same curated HTTPS host allowlist as `http:default`, and add a contract test in `csp-capability.contract.test.ts`. Call it from `secureFetch` for multipart uploads only. Removes the handshake (0.1 to 0.4 s) and the JSON byte array (0.1 to 0.55 s).
2. **Pre-warm on recording start.** Issue a `HEAD` request to the active provider host through the pooled client when `start_recording` succeeds, so the TLS session is warm by stop.
3. **Binary `store_transcription_audio`** using the same raw request pattern.
4. **Local model defaults.** Recommend Parakeet TDT or `large-v3-turbo` with GPU when `get_machine_capabilities` allows. Enable whisper.cpp VAD with a Silero model.
5. **AssemblyAI batch polling**: 250 ms, 500 ms, 1 s, then 3 s.

Target after M2: 60 s Groq dictation ~0.5 s (13x), 10 s dictation ~0.5 s (3x).

Metric: pipeline trace `transcribed - stopped` p50 and p95 per provider, plus TLS handshake count per dictation (should be 0 after warm-up).

### M3, remove upload time entirely (2 to 4 weeks)

1. **FLAC encoding** of the upload (lossless, about 50 to 60% of PCM16 for speech), in Rust or a WASM encoder. Groq recommends FLAC for size reduction ([Groq docs](https://console.groq.com/docs/speech-to-text)).
2. **Streaming request body.** Open the provider request at recording start and write the WAV body with chunked transfer encoding as audio arrives, so at stop only the last few KB and the provider inference remain. This requires the pooled Rust upload command, because the webview fetch path cannot stream request bodies through plugin-http. Verify per provider that chunked multipart is accepted; fall back to pretranscription otherwise.
3. **Sidecar incremental decode.** Move pause segmentation into `streaming_sessions.rs`: on append, run the same VAD, and when a pause closes a segment of 20 s or more, run `whisper_full` or ONNX on it in a background task while recording continues. `/finalize` then decodes only the last segment. This removes the extra HTTP round trip per span in the TypeScript path and lets the sidecar reuse one `WhisperState`.
4. **Binary `audio_chunk` via `tauri::ipc::Channel`**, cutting per-event JSON during recording.

Target after M3: batch cloud ~0.3 to 0.4 s at any length (15x to 20x at 60 s, 4x to 5x at 10 s). Local: one short segment of inference after stop.

### M4, streaming everywhere (optional, larger)

- Offer OpenAI Realtime transcription (`intent=transcription`, `gpt-4o-mini-transcribe`) as a streaming session. Commit manually on stop, because server VAD delays deltas until speech stops.
- For local, a LocalAgreement-2 streaming mode for interim text (arXiv 2307.14743), gated behind a setting because of the reported +2% WER.

Target: post-stop wait equals one finalize round trip, about 150 to 300 ms, for every dictation length. That is the only way to get 10x on very short dictations, because a 5 s batch request is already bounded by RTT plus inference.

## 6. Validation plan for rollout

1. **Latency.** Log the pipeline-trace summary per dictation. It is already threaded to history via `trace`. Add the pretranscription span count. Compare p50 and p95 of `stopped -> transcribed` and `stopped -> inserted`, bucketed by recording length (under 15 s, 15 to 60 s, over 60 s) and provider.
2. **Accuracy.** Run the existing `test/integration/transcription.test.ts` and eval suites with provider keys on long fixtures. Add a fixture of 60 s or more with natural pauses, and compare WER of whole-recording vs pretranscribed output. Acceptance: WER delta under 0.5 absolute.
3. **Robustness.** Watch the warning `pretranscription unusable` rate. It should stay near 0; any rise means stream and recording diverged on some platform, and the fallback keeps output correct while costing the speedup.
4. **Cost and rate limits.** Requests per dictation should stay around 1 + length / 12 s for cloud. Confirm no new 429 responses on Groq free tier.
5. **Rust CI.** `cargo test` for `recorded_audio_encoding_prefixes_rate_and_packs_f32_le`, `check-bindings.sh`, and a manual smoke test of dictation, microphone test, and composer voice edit on Windows, macOS, and Linux.
