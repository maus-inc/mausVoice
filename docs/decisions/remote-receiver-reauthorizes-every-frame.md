# The remote receiver re-authorizes every frame against the device row

Date: 2026-11-06
Status: accepted

## Context

A paired phone delivers final transcripts to the desktop over plain TCP on the
LAN. The receiver used to compare the pairing code once at `SessionHello`, keep
the accepted device id in memory, and trust that connection for its lifetime.
Two things cannot be expressed in that shape: revoking a device while it holds an
open connection, and noticing that the connection no longer belongs to a trusted
device at all.

The transport has no TLS, so the shared secret is a bearer token and the receiver
is the only thing that bounds what a peer may do with it.

## Decision

Pairing stays a one-time exchange, and the accepted device receives a 16-byte
shared secret. `SessionHello` verifies it with `secret_matches`, which compares
the full secret instead of stopping at the first differing byte, and the session
keeps the token rather than only the device id.

Frames are newline delimited, and `read_frame` refuses a frame larger than four
mebibytes. The cap exists because authorization happens after parsing: a peer
that never sends a newline could otherwise grow the read buffer until the
process ran out of memory, and nothing has checked that peer's secret yet.

After that, every `final_text` frame is authorized on its own.
`authorize_final_text` re-reads the device row inside the same generation guard
the connection already uses and requires it to still be trusted and to still
match the retained secret. A failed check clears the session, so the peer has to
present `SessionHello` again before it can deliver.

## Consequences

Revoking or re-trusting a device takes effect on its next frame, with no
connection bookkeeping to keep in sync, at the cost of one indexed SQLite read
per delivery frame.

Because there is no TLS, a peer that can read the LAN traffic learns the secret
and can impersonate the sender until the device is revoked. The receiver accepts
that on a trusted home network and mitigates it with single-use pairing and
per-frame authorization and a bounded frame.

The receiver keeps no read or write timeout, and it does not cap the number of
open connections: a peer that connects and stays silent holds a task until it
sends a frame or disconnects. Both were considered and left out of this change,
which is why the framing cap is the only bound on a single peer.
