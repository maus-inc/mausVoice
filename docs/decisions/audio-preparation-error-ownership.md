# Audio preparation owns its error until settlement

Date: 2026-11-06
Status: Accepted

## Context

The saved-audio player crosses two completion boundaries. Repository loading returns samples. Web Audio preparation allocates a context, creates and connects a source, then schedules playback. Playback ends later through a stop callback.

The utility also invokes that callback when it cleans up a startup failure. A callback does not therefore prove that the preparation promise succeeded.

## Decision

`AudioPlayerPill` retains request identity until `playWebAudio` settles. A stop during preparation records that playback has already stopped. Successful settlement then leaves the control idle. Rejection still reaches the existing localized error notification.

Once preparation succeeds, ordinary stop callbacks clear the request immediately. Releasing an attempt aborts its `AbortController` (tearing down in-flight Web Audio setup) and releases global ownership; `AudioPillPlaybackSession` is the request owner that carries this controller. Cancellation from another row or unmount still prevents stale errors and late playback.

Do not suppress every error following a stop callback. Distinguish cancellation from cleanup caused by failure.

## Consequences

- A stop callback can no longer be mistaken for preparation success; settlement, not the callback, decides whether the error surfaces.
- Attempt teardown aborts in-flight Web Audio setup, so a replaced or cancelled attempt cannot play late audio.
- Callers must keep request identity stable until settlement, or route a teardown through the attempt owner.

## Verification

`apps/desktop/src/components/transcriptions/AudioPlayerPill.lifecycle.test.tsx` covers teardown followed by rejection, completion before preparation settles, ordinary completion followed by replay, and the real playback utility with a throwing source. The source test mocks the browser device boundary rather than the utility and verifies context closure and the user-facing error.

## References

The review used baseline `0aec307e4ad9cff2e9c09d2401b5e7e19894c0ff`, React Router 6.30.4, and MUI 9.3.1. No dependency upgrade was needed.

- [AudioBufferSourceNode.start](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start) documents scheduling and exceptions.
- [AudioScheduledSourceNode ended event](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/ended_event) describes source termination rather than preparation success.
- [Web Audio lifetime discussion](https://github.com/WebAudio/web-audio-api/issues/904) distinguishes stopping playback from releasing JavaScript references. The discussion is background, not proof of this application's defect.
