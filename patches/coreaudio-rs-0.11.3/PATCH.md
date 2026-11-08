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

The macOS device-name query validates its returned CoreFoundation pointer,
releases successfully returned strings, and sizes its UTF-8 conversion buffer
instead of imposing a 255-byte limit. Simulated CoreAudio/CoreFoundation tests
cover direct and long names, malformed data and conversion errors. Real macOS
names and CoreFoundation ownership behavior have not been exercised here.

The macOS hog-mode helpers pass correctly sized mutable PID storage to
CoreAudio and validate returned lengths. A simulated API tests toggling,
malformed output and native errors; hardware behavior remains unverified.

The macOS device-scope query uses initialized, aligned native-word storage for
the variable-length `AudioBufferList`. It checks returned lengths and buffer
counts before reading channel counts, including empty and shrinking lists.
Portable simulated-API tests exercise the parser; macOS devices remain untested.

The macOS physical-format helpers use initialized mutable property buffers and
validate returned byte counts, including shrinking format lists. The setter
compares full sample rates rather than truncating them. A simulated API exercises
these paths and timeout handling; actual device behavior remains unverified.

The macOS sample-rate setter validates initialized property data and returned
range lengths, accepts rates within continuous ranges, and sends one `f64`
nominal rate to CoreAudio. A simulated API tests success, invalid data, native
errors and notification timeout; actual sample-rate changes remain unverified
on macOS hardware.

The macOS device-ID queries pass mutable output storage to CoreAudio, initialize
allocated IDs, and validate returned byte counts before exposing them. A shorter
valid result is truncated; malformed or oversized lengths return an error. A
portable simulated API exercises the queries, but does not replace physical
macOS device testing.

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
