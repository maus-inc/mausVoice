---
title: "API key management"
description: "Add, test, select, rotate, and remove task-specific provider credentials."
sidebar:
  order: 6
---

Open **Settings → Processing → AI transcription**, **AI post processing**, or **Assistant mode**. Each dialog filters the key list to providers registered for that task. A saved credential is a reusable record; the selected card determines which record that task uses.

## Add and select a record

Choose **Add API key** or **Add another key**, enter a descriptive **Key name**, choose the provider, and complete its fields. Standard hosted providers require one secret. Azure Speech requires a region and subscription key; Azure OpenAI requires a resource endpoint and API key. Ollama and OpenAI-compatible endpoints accept optional authentication, while Speaches has no key field.

Saving creates and selects the record. If a task has compatible records but no selected ID, the dialog automatically selects the first displayed one. A generic model picker may load provider models and also accepts a typed model name. A model must match the task: a chat model cannot transcribe merely because the same credential can access both.

**Test** makes a provider-specific network call. It checks basic credentials or endpoint reachability, not the exact selected model in every case, available quota, streaming behavior, language support, future requests, or provider retention. For example, the OpenAI-compatible test lists models, and the Speaches test calls `/health`.

## Quick Groq and Deepgram rows

The top-level rows are more than duplicate password fields:

- Saving **Personal Deepgram** prefers that record for transcription when the current choice is unset, Local, or already one of the managed personal records.
- Saving **Personal Groq** assigns `whisper-large-v3-turbo` for transcription and `openai/gpt-oss-20b` for generation when those model fields need defaults. It can make Groq the transcription fallback and set post-processing and the Assistant backend to API when those choices are unset or already managed by this personal record.
- An unrelated provider record you explicitly selected is preserved. The separate Assistant feature switch remains its own control.

Use the full task dialog when you need another record name, provider, or model.

## Edit, rotate, and delete

The UI never repopulates the password field. In edit mode, leave it blank to retain the encrypted value; entering text replaces it. Edit endpoint, region, model, or `/v1` handling with the same care as the secret, then test before revoking the old credential at the provider.

Deleting removes the local credential. If it is selected for transcription or post-processing, those preferences are reset to an unset mode and key. The current delete action does not explicitly clear an Assistant selection, so revisit **Assistant mode** after deleting a credential it used.

## Storage boundary

The full secret is encrypted in SQLite with XChaCha20-Poly1305 and a fresh 24-byte nonce; the UI retains a short non-secret suffix for identification. A compile-time `MAUSVOICE_API_KEY_SECRET` takes precedence over a runtime value, followed by a machine/user-derived fallback. Changing an explicit secret can make existing records unreadable. Encryption protects data at rest, not requests sent to the chosen provider or malware running as your logged-in user.
