# A stop during streaming startup keeps the audio but cannot use the stream

Date: 2026-11-05
Status: accepted

## Context

`startPreparedSession` awaits `session.onRecordingStart(sampleRate)` before it
publishes the audio sink (`apps/desktop/src/components/root/dictation-recording-intake.ts`).
While that await runs, the user can release the key. The stop path then finalizes
with the audio it got from `stop_recording`, and a streaming provider has not
connected yet.

Deepgram's session awaits its startup promise in `finalize` before delegating to the
base class. AssemblyAI, Azure, ElevenLabs, and Gladia do not, so their finalize sees
no stream and returns `notEstablishedResult()` with the warning
"<provider> streaming session was not established".

Awaiting startup in every provider looks like the fix and is not one. If the socket
opens after the stop retired the session, `startPreparedSession` resumes, sees
`!isCurrent()`, cancels the lease, and returns without ever installing the buffer
sink. The captured audio stays in the intake buffer and is dropped with the session.
The provider therefore acknowledges an empty stream, and the run resolves with no
transcript and no warning, which is worse than the current path: a null transcript
with a warning keeps the audio for a retry, and the stop path stores it that way.

## Decision

Keep the per-provider behaviour and treat `notEstablishedResult()` as the correct
outcome for a stop that lands during startup. The recording survives because its
audio is retained and the failure is reported, not because the stream is repaired.

Rejected: awaiting startup inside the base `finalize`. It bounds the stop by the
20 s websocket startup timeout, delays the pill, and still loses the audio because
no sink is attached after retirement. Also rejected: silently swallowing the
`notEstablishedResult` warning, which would make the run look like an empty
recording rather than an unavailable provider.

## Consequences

The failure mode is visible in History and retryable through the stored audio. A
future batch fallback for streaming providers belongs in the stop path, where the
audio is already in hand, not in `finalize`, where only the stream is reachable.

Provider adapters that share a socket lifecycle now share one implementation
(`apps/desktop/src/sessions/socket-stream-session.ts`) and keep only their URL, frame
handling, log level, and termination frame. Deepgram's startup await stays because it
serializes against its own late-open socket, not because it recovers audio.
