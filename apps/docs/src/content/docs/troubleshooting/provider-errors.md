---
title: "Provider and API errors"
description: "Separate invalid credentials, endpoint mistakes, unavailable models, quota, and optional rewrite failures."
sidebar:
  order: 7
---

Use the provider entry's integration test first. If it fails, verify the exact provider, required fields, base URL, region, and whether the account key is active. Do not share the secret.

A successful test proves only a basic call. Real requests can still fail because the selected model is unavailable, the account lacks access or quota, input is too large, an upstream route is down, or a safety policy stops generation.

Turn post-processing Off and make a short recording. If raw transcription succeeds, the speech provider is healthy and the later generative request is failing. If API transcription fails, switch temporarily to a downloaded Local model to verify microphone and insertion independently.

For custom endpoints, inspect `/v1` path handling and confirm localhost refers to the desktop host. For Azure, do not confuse Speech region with Azure OpenAI endpoint. Preserve status codes and sanitized response messages in Diagnostics.
