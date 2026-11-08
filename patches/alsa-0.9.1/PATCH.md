# Local ALSA wrapper patch

Based on `alsa` 0.9.1. `PCM::close_checked(self)` consumes the native handle
and reports the result of `snd_pcm_close`; unlike the upstream destructor it
does not ignore failure. It never retries or drops the handle a second time,
because a failed close may already have invalidated it. The CPAL input teardown
uses this after its capture worker has exited and `snd_pcm_drop` succeeded.
CPAL uses it for capture setup failures and capability probes too.

`PCM::new_checked` distinguishes ordinary open errors from a failed open that
returns a non-null pointer, or a successful open that returns null. It does not
close an ambiguous pointer because the native call may already have invalidated
it. CPAL uses the distinction to block later capture. A failed open with a null
pointer still relies on ALSA and its plugins to clean up internal resources. The
ordinary destructor remains unchanged. Real-driver verification is still required.

`Status`, `ElemId`, and `SelemId` use stack storage aligned like a C allocation
before passing it to ALSA. The previous byte arrays had alignment one. Mutable
status and simple-mixer operations now derive their pointers from mutable
borrows. This keeps the audio status path allocation-free. Unit tests check the
alignment and exercise the status builder with ALSA's null PCM; real-device
and non-Linux platform behavior still need verification.

Each `ChmapsQuery` item owns a byte-for-byte copy of its channel map, including
position flags. ALSA frees the original maps with the query, so returning a
borrowed pointer let safe callers access freed memory after dropping it.

Direct mmap constructors require an unsafe `MmapSample` implementation and
verify the configured PCM format. Primitive audio samples implement it; custom
sample types must guarantee that every bit pattern is valid and that their
layout matches the declared format. This intentionally narrows a previously
unsound public API.
