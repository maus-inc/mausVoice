# The remote receiver authenticates every frame against the database

Date: 2026-11-06
Status: accepted

## Context

A paired phone delivers final transcripts to the desktop over plain TCP on the
LAN. The earlier receiver compared the pairing code once, kept the accepted
device id in memory, and then trusted the connection for its lifetime. Two
things could not be expressed in that shape: revoking a device while it holds an
open connection, and knowing whether a connection belonged to the device that
paired.

The transport has no TLS, so the shared secret is a bearer token and the
receiver is the only thing that can bound what a peer does with it.

## Decision

Pairing stays a one-time exchange. The pairing code is 16 random bytes rendered
as hex, `consume_pairing_code` compares and replaces it under one lock so two
connections cannot both win, and the accepted device receives a 16-byte shared
secret.

After that, every frame is authorized on its own. `authorized_sender` checks the
session id, re-reads the device row, and requires the row to still be trusted,
still hold the sender role, and still match the secret. The comparison goes
through `secret_matches` so it does not stop at the first differing byte. A
failed check clears the session, so the next frame has to present `SessionHello`
again.

The listener bounds the peer as well: frames are newline delimited and capped at
4 MiB, writes time out after 5 seconds, reads time out after 30, and at most 32
connections run at once. A run of `accept` failures is retried, and after five
consecutive failures the receiver records the error and stops, so the status
cannot report an enabled receiver with no listener behind it.

## Consequences

Revoking or re-trusting a device takes effect on its next frame with no
connection bookkeeping to keep in sync, and the cost is one indexed SQLite read
per frame. Because there is no TLS, someone who can read the LAN traffic learns
the secret and can impersonate the sender until the device is revoked. The
receiver accepts that on a trusted home network and mitigates it with
single-use pairing, a bounded frame size, and per-frame authorization.
