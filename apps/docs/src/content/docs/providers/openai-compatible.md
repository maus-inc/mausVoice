---
title: "OpenAI-compatible endpoints"
description: "Connect compatible chat and audio APIs with explicit base-path, model, authentication, and transport choices."
sidebar:
  order: 8
---

Choose **OpenAI Compatible** when a service implements the relevant OpenAI-shaped endpoints. This is a protocol option, not a guarantee that every server calling itself compatible supports transcription, chat streaming, JSON schemas, or Assistant tool calls.

## Connection fields

- **Base URL** defaults to `http://127.0.0.1:8080`. Enter the server root or API base, not `/chat/completions` or `/audio/transcriptions`.
- **API key** is optional. When present, mausVoice sends it as a Bearer token.
- **Include /v1 path** defaults on. At runtime, mausVoice strips trailing slashes and appends `/v1` unless the URL already ends in `/v1`. Turn it off when your server exposes the OpenAI routes directly beneath the entered base.
- The transcription form has an optional **Model** field and falls back to `whisper-1`. Generation requires a selected or typed model.
- The transcription form has an optional **Transcription path** override (defaults to `/audio/transcriptions`). Set it when the server exposes the STT endpoint at a different route — for example, `/v1/audio/transcriptions` for Open WebUI, or a vendor-specific path. Leave empty to keep the default. Whitespace is trimmed; a leading slash is added if missing.

For transcription, the resolved route is `{runtime base}{transcription path}`. mausVoice submits WAV multipart data with `file` and `model`, plus optional `prompt` and a non-Auto `language`. Long input is divided into 60-second segments with five-second overlap and up to three concurrent requests. This is a batch route and cannot feed real-time output.

Generation uses chat completions at the resolved API base. A server may handle ordinary post-processing but reject Assistant tool schemas or streaming; test those separately.

## Test and picker caveats

The current **Test** passes the entered base URL directly to an OpenAI client and lists models; it does not apply the **Include /v1 path** switch. The live model picker independently probes `/v1/models`. Runtime requests do apply the switch. A valid deployment can therefore show different outcomes between the test, picker, and actual request when its routes use an unusual prefix. Use server access logs to verify the exact paths.

`http://` sends audio, text, and any Bearer token without TLS. Loopback confines routing to this computer, but not to a particular process; a LAN hostname exposes the traffic to that network. Prefer HTTPS and authenticated access for any non-loopback endpoint.
