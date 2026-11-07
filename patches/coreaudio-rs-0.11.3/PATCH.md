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

The existing destructor and callback APIs remain in use for output and iOS.
Their unchecked teardown is not fixed by this patch. A successful checked close
and token retirement prevent late input callbacks from accessing released
callback storage, but they do not establish how every macOS driver behaves.
Physical-device and macOS runtime testing are still needed.
