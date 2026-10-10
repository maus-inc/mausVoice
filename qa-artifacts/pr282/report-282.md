## QA report: stop-to-History latency, raw audio IPC and concurrent row write

I ran this branch in the browser preview, drove the two changed paths by hand, and measured both. Verdict: both bottlenecks are real and both are fixed. The recording no longer crosses IPC as JSON, and the History row no longer waits for the text to be typed into the destination.

### Bottleneck 1: the audio no longer crosses IPC as JSON

I encoded a two minute 48 kHz recording both ways in the running app and compared.

| Measure | JSON sample array | Raw binary |
| --- | --- | --- |
| Payload | 115,560,289 chars | 23,040,004 bytes |
| Ratio | 5.02x larger | baseline |
| Encode | 548.1 ms stringify + 284.8 ms parse | 11.7 ms |
| Decode | on top of parse | 0.2 ms |
| Round trip | exact | exact, max sample diff 0 over 5,760,000 samples |

The raw format is `[u32 LE sample rate][f32 LE samples]`, the same framing `stop_recording` already returns, so one format describes a recording in both directions. The round trip through `decodeStopRecordingPayload` reproduced all 5,760,000 samples with a maximum difference of 0 and the rate intact.

### Bottleneck 2: the row no longer waits for delivery

The row now lands when the WAV write and DB insert finish, not after the transcript is typed out. I drove the real modules in the app to check the two ownership paths.

| Path | Row written by | Second row written | Stop path returns |
| --- | --- | --- | --- |
| Serial (stop-path owner) | the stop path | no | after the store settles |
| Concurrent (strategy owner) | the strategy during delivery | no | after the strategy's promise settles |

For the concurrent path the stop path awaited the strategy's promise and never wrote a second row. The session stays locked exactly as long as the serial path, which is what the branch claims.

### The one behavior change: the truncation toast

This is the only intentional behavior change, and I proved it in the real UI against the base commit.

![Fast-styling truncation toast, before and after](https://work-1-ranlryontuidqusg.prod-runtime.all-hands.dev/pr282/282-cmp-truncation-toast.png)

| State | Base | This branch |
| --- | --- | --- |
| Incognito | "The unstyled ending is in History." | "incognito mode is on, so that ending was not saved." |
| Row stored | "The unstyled ending is in History." | "The unstyled ending is in History." |

On the base the incognito path promised History for a row that was never written. I rendered both toasts in the real UI and read the text, and I checked the store read path so the branch's `isPersistenceAllowed()` guard is exercised, not stubbed.

![Truncation toast flow on this branch](https://work-1-ranlryontuidqusg.prod-runtime.all-hands.dev/pr282/282-flow.gif)

The recording shows the stored wording, then the incognito wording, over the Transcriptions page.

<details>
<summary>Programmatic proof</summary>

All of the below was driven by loading the real branch modules inside the running preview app.

**Raw audio encoding**, two minutes at 48 kHz:

```
binaryBytes  23040004
jsonChars    115560289   (5.02x)
encodeMs     11.7        (binary)
stringifyMs  548.1       (json)
parseMs      284.8       (json)
decodeMs     0.2
roundTripExact true, maxSampleDiff 0, decodedRate 48000, decodedLen 5760000
```

**Concurrent row write**, driven with a deferred strategy promise:

```
beforeResolve:settled=false     the stop path is still waiting
afterResolve:returnedAtMs=251   it returned once the promise settled
secondRowWritten=false          no duplicate row
```

**Truncation toast wording**, against the live store gate:

| Case | Rows | Toast |
| --- | --- | --- |
| normal | 1 | "...The unstyled ending is in History." |
| incognito at capture | 1 | "...incognito mode is on, so that ending was not saved." |
| incognito now, allowed at capture | 1 | "...incognito mode is on, so that ending was not saved." |
| ephemeral session now | 1 | "...incognito mode is on, so that ending was not saved." |

The last three rows are the bug the branch fixes. I set incognito through the app store the running app reads, confirmed the store read the value back, and confirmed `isPersistenceAllowed()` flipped, so the guard is exercised through the real read path rather than a mock.

**Toast rendering**, read from the live DOM:

```
stored:    rgb(26,23,18) on rgb(253,251,248), 13.5px, 356x67
incognito: rgb(26,23,18) on rgb(253,251,248), 13.5px, 356x87
```

**Targeted suites**, run locally on this head:

```
transcribe.actions        28 passed
dictation.strategy        28 passed
DictationSideEffects      23 passed
recorded-audio.utils      19 passed
total                     98 passed, 4 files
```

</details>

<details>
<summary>Why the pill is not in the screenshots</summary>

The dictation pill is a native Rust canvas surface, not a DOM node. `sendPhaseToPill` calls the `set_phase` Tauri command, which the browser preview answers as a no-op. A screenshot of the preview's pill recreation would not be the shipped surface, so I proved the dispatch order and the row-write behavior instead, which is where this change lives.

</details>

<details>
<summary>Merge note</summary>

This branch and #284 both edit the stop path in `DictationSideEffects.tsx` and the same locale keys. A test merge of the two conflicts in `DictationSideEffects.tsx` and all ten locale files. They need to land in a deliberate order or be rebased onto each other.

</details>

### Artifacts

All images are served from the sanctioned preview host. The same files are mirrored on the [`qa-artifacts`](https://github.com/maus-inc/mausVoice/tree/qa-artifacts/qa-artifacts/pr282) branch.

<details>
<summary>Full artifact list</summary>

Comparison: `282-cmp-truncation-toast.png`.

This branch: `282-after-stored-toast-crop.png`, `282-after-incognito-toast-crop.png`, `282-after-stored-truncation-toast.png`, `282-after-incognito-truncation-toast.png`.

Base: `282-base-incognito-toast-crop.png`.

Recording: `282-flow.gif`.

</details>

---

MausAgent | Filed by `openhands-agent`, with @Owie6789, on 2026-10-09
