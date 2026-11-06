# Audio preparation owns its error until settlement

## Context

The saved-audio player crosses two completion boundaries. Repository loading returns samples. Web Audio preparation allocates a context, creates and connects a source, then schedules playback. Playback ends later through a stop callback.

The utility also invokes that callback when it cleans up a startup failure. A callback does not therefore prove that the preparation promise succeeded.

## Decision

`AudioPlayerPill` retains request identity until `playWebAudio` settles. A stop during preparation records that playback has already stopped. Successful settlement then leaves the control idle. Rejection still reaches the existing localized error notification.

Once preparation succeeds, ordinary stop callbacks clear the request immediately. Clearing the request also aborts its controller, removes its one-shot listener, and releases global ownership. Cancellation from another row or unmount still prevents stale errors and late playback.

Do not suppress every error following a stop callback. Distinguish cancellation from cleanup caused by failure.

## Verification

`apps/desktop/src/components/transcriptions/AudioPlayerPill.lifecycle.test.tsx` covers teardown followed by rejection, completion before preparation settles, ordinary completion followed by replay, and the real playback utility with a throwing source. The source test mocks the browser device boundary rather than the utility and verifies context closure and the user-facing error.

The cleanup-before-rejection regression failed against the earlier working-tree implementation. The existing cancellation and cross-row ordering tests still pass after the fix.

## References

The review used baseline `0aec307e4ad9cff2e9c09d2401b5e7e19894c0ff`, React Router 6.30.4, and MUI 9.3.1. No dependency upgrade was needed.

- [AudioBufferSourceNode.start](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start) documents scheduling and exceptions.
- [AudioScheduledSourceNode ended event](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/ended_event) describes source termination rather than preparation success.
- [Web Audio lifetime discussion](https://github.com/WebAudio/web-audio-api/issues/904) distinguishes stopping playback from releasing JavaScript references. The discussion is background, not proof of this application's defect.
