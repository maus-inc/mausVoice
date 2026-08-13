---
title: "Diagnostics"
description: "Open the log directory and export a reviewable troubleshooting archive."
sidebar:
  order: 11
---

Open **Settings → General → Diagnostics**. The compact on-screen view shows the app version and user ID, plus the effective transcription, post-processing, Assistant, and styling modes. **Open** reveals the application log directory. **Download** asks where to save `mausvoice-diagnostics.zip`.

## What the ZIP contains

`diagnostics.txt` includes:

- generation time and app version;
- user ID, display name, and email when present;
- effective plan, stored member plan, trial status, and days remaining;
- transcription mode, local model size, and device;
- post-processing, Assistant, and styling modes;
- auto-launch state.

The archive also copies every regular file currently present in the log directory into `logs/`. Startup diagnostics can disclose timestamp, OS, architecture, OS family, and hostname. The app normally keeps the ten most recently modified log-directory files when it runs startup cleanup.

## Sanitization boundary

Before adding a UTF-8 log file, the exporter applies targeted replacements for known transcript-preview, processed-transcript, LLM-output, and Azure final-transcript log patterns. This is a defense-in-depth filter, **not** a guarantee that the archive is anonymous or free of speech content. Unrecognized log wording is left unchanged, and a non-UTF-8 file is copied as raw bytes. The generated `diagnostics.txt` deliberately contains account metadata and is not passed through the log sanitizer.

After exporting, unzip the archive locally and inspect every file before sharing it. Redact names, email, user and host identifiers, private paths, transcript fragments, provider responses, and anything unrelated to the report. Never attach API keys, a raw database, or private audio.

## Pair the archive with a reproduction

Include the operating system and package type, the smallest reliable steps, selected provider/model without its secret, target application and insertion method, and whether correct text reached History or the clipboard. For a security-sensitive finding, follow the [private reporting guidance](../../privacy-security/reporting-security-issues/) rather than uploading the ZIP to a public issue.
