# coreaudio-rs 0.11.3 checked close

This directory contains the registry crate and its original licenses. The
Cargo.lock SHA-256 for the original crate is
`321077172d79c662f64f5071a03120748d5bb652f5231570141be24cfcd2bace`.

The macOS-only `raw_instance` and `close_stopped` APIs support CPAL's managed
input callback. The caller must stop the unit, retire and drain every callback
that can use its native handle, and prevent further handle use. Checked close
records an uncertain state before calling uninitialize or dispose. If either
call fails, the handle is not used or retried because the API does not establish
that an error leaves it valid. The destructor also avoids touching a handle after
checked close starts. CPAL keeps recorder ownership reserved on failure.

When initialization fails after instance creation, the constructor now calls
`AudioComponentInstanceDispose` and reports an uncertain cleanup if disposal
fails. CPAL maps that result to its capture ownership guard. Portable tests
exercise the ordering and error propagation, but do not call Apple APIs.

The macOS `RateListener` and `AliveListener` use non-reused registry tokens
instead of pointers to movable listener objects. Late callbacks after removal
are inert, and an in-flight callback retains its own state even if removal fails.
Property reads use mutable storage and check returned lengths; dropped channel
receivers and poisoned queues cannot unwind through CoreAudio. Repeated
registration is idempotent. `RateListener::queue` remains accessible as a
`Mutex` through shared state, but cannot be replaced through a mutable listener.
Portable tests call the actual adapter through a simulated
CoreAudio API, including failed registration/removal and in-flight delivery;
physical macOS behavior is not established by those tests.

The legacy input callback now keeps its sample `Vec` owned by the callback
instead of reconstructing it from CoreAudio's mutable byte count on teardown.
Buffer size multiplication is checked before allocating or resizing. Portable
unit tests exercise resizing and size bounds, and a source contract checks the
ownership wiring; neither runs `AudioUnitRender` or proves native teardown.

The existing destructor and callback APIs remain in use for output and iOS.
Their unchecked teardown is not fixed by this patch. A successful checked close
and token retirement prevent late input callbacks from accessing released
callback storage, but they do not establish how every macOS driver behaves.
Physical-device and macOS runtime testing are still needed.
