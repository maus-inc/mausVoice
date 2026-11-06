# Abort drops a lease whose cancel was rejected, because nothing can consume the audio

Date: 2026-11-06
Status: accepted

## Context

`stopNativeRecordingForAbort` in
`apps/desktop/src/components/root/dictation-recording-intake.ts` takes the lease out of
`nativeStartOwnerRef` and calls `lease.cancel()`. A synchronous throw puts the lease
back, so a failed dispatch stays visible to the caller. An asynchronous rejection —
`cancel()` returning a rejected promise, which is what a failed `stop_recording` produces
— leaves the ref null. That looks like the ownership race the native recorder work was
about, and restoring the lease on rejection is the obvious repair.

It is the wrong repair, for three reasons that only show up when the two consumers are
read together.

1. Recovered audio has no consumer after an abort. The retained copy is served by
   `NativeRecordingLease.waitForStopRecovery`, and the only caller is
   `captureStopRecordingInfo` in `dictation-finalization.hooks.ts`, which runs from a
   stop. An abort never stops: it invalidates the operation token, clears the session
   and strategy, and returns. Restoring the lease therefore retains a recording that no
   code path will ask for.
2. A retained lease blocks the next start. `claimRecordingStart` refuses while
   `hasNativeLease` is true, `beginRecording` returns silently on that refusal, and the
   only way to clear the ref is a stop attempt that cannot happen while every start is
   refused. The user's hotkey would do nothing until the app is restarted.
3. The microphone is not abandoned. `createAbortSafety` watches the abort's native stop,
   passes `retry: () => lease.cancel()` to `monitorAbortRelease`, and shows "The
   microphone may still be in use. If its indicator stays on, quit the app." when
   release is not confirmed. The retry keeps reaching the lease through the closure, so
   the ref is not needed to release the capture — only the retained audio is
   unreachable.

Fixing this properly means letting an abort hand its retained audio to a recovery
surface — the same design the browser-side orphan recovery note defers. It is a feature,
not a guard.

## Decision

Keep clearing the ref. On an asynchronous rejection, report the failure through
`onUnconfirmed` and leave the lease unreferenced.

Rejected: restoring the ref on rejection. Rejected: keeping a second, non-blocking
registry of abandoned leases, because nothing reads it and it would keep audio in memory
for the lifetime of the process.

## Consequences

An aborted recording whose native stop fails loses its captured audio. The user is told
the microphone may still be in use, which is the part they can act on.

`dictation-recording-intake.test.ts` pins all three behaviours: the synchronous-throw
restoration ("keeps the lease reachable when cancellation throws synchronously"), the
rejection path's unconfirmed warning ("keeps cancellation guidance when a real lease's
discard is rejected"), and the retry that still dismisses that warning ("retries a
rejected real-lease discard before dismissing its warning"). A change that restores the
ref will fail a test rather than silently wedging recording starts.
