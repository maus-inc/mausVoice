---
title: "API key security"
description: "Understand the at-rest encryption boundary and rotate credentials safely."
sidebar:
  order: 3
---

Before an API credential is written to the local database, the Rust backend encrypts it with **XChaCha20-Poly1305** and a fresh 24-byte nonce. `MAUSVOICE_API_KEY_SECRET` provides an explicit secret. A value embedded at compile time takes precedence over the runtime environment; if neither is present, mausVoice derives a fallback from a fixed application label, the available machine identifier, and the user profile. It can also try the older, pre-machine-ID fallback when reading legacy rows.

Keep an explicit secret stable for the life of the stored credentials: changing or removing it can make existing rows undecryptable. Packagers should set it at build time; local developers can supply it in the process environment before the Rust backend first accesses a key. Do not place the value in a committed environment file.

Authenticated encryption helps protect copied database contents and detects ciphertext tampering. It does not protect a key from malware or another process acting with the same user's privileges while mausVoice can decrypt it for use. It also does not control provider-side request logs.

Treat a diagnostics archive, database backup, and app configuration as sensitive even when key values are encrypted. Do not commit `.env` files or keys to the repository and do not paste secrets into screenshots or issues.

If exposure is possible, revoke the key at its provider, create a replacement, test the new entry in mausVoice, and remove the old one. Clearing local data alone cannot revoke a credential that remains active in the provider account.
