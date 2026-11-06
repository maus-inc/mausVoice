# Audio preload slots belong to pending reads

## Decision

`TranscriptionAudioCache` counts pending loads independently of its retained entries. Each new load reserves one slot synchronously. Its returned promise releases the slot in `finally`, after either success or failure. Reusing a pending promise reserves no extra slot.

Invalidation removes permission to reuse or publish samples. It does not release a pending read's slot. Explicit playback can still start a read when speculative warming is blocked.

## Evidence

The previous `canWarm()` counted unresolved entries in the cache map. Deleting an entry, or clearing the map, made that count fall while the native operation was still running. Two regression cases failed because `canWarm()` returned true with two unsettled reads. A repository test also exercises deletion during pending reads.

The shared limiter has one production consumer in `AudioPlayerPill`. The repository enters `withLocalDataWrite` and calls the cache synchronously before awaiting the result. There is no asynchronous gap between the component's admission check and the cache reservation in this path.

The tests cover single-entry and whole-cache invalidation, deduplicated requests, synchronous loader failure, slot reuse, and repository deletion. Native disk and audio hardware behavior remain separate acceptance work.

## Sources and scope

This decision refines issue #300 on baseline `0aec307e4ad9cff2e9c09d2401b5e7e19894c0ff`. It changes no UI, native command, or dependency.

- [MDN Promise.finally](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/finally) documents cleanup on fulfillment and rejection. The cleanup must not throw or return a rejected promise, since that would replace the original result.
- Installed `@tauri-apps/api` 2.10.1 defines invoke options with headers, not an abort signal. The managed audio read has no cancellation command. Removing its cache entry therefore cannot stand in for native cancellation.

The general lesson is to track unfinished operations separately from reusable results. Cache eviction and operation completion have different lifetimes.
