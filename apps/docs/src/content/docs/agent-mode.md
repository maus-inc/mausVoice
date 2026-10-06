---
title: "Agent mode"
description: "The two agent modes in mausVoice: assistant mode (chat with tools) and computer use (the assistant drives the screen)."
sidebar:
  order: 9
---

mausVoice has two agent modes. Both are experimental and off by default.

## Assistant mode

The assistant answers in chat and can call tools: paste text, read the screen, run allowlisted shell commands (power mode), and end the conversation. It streams its reply, asks before running anything risky, and can be stopped at any time.

Full configuration, the tool list, the permission flow and the risk tiers live in [Assistant mode](/using-mausvoice/assistant-mode/).

## Computer use

When computer use is on, the assistant does not just talk about the screen. It looks at a screenshot, decides what to click or type, and does it. Each action asks for approval first unless you have already allowed that kind of action.

The same risk tiers apply. A click is a bigger decision than a screenshot, and the prompt says so before asking.

Computer use needs a model that can drive a screen. If the selected model cannot, the assistant says so and falls back to a normal chat reply.

## Stopping a run

The Stop button ends either mode. It cancels the model request, cancels any action that is still running, and takes the permission card off the screen. Nothing is left half-done.

## Where the code lives

| Layer | Path |
| --- | --- |
| Portable action vocabulary | `packages/types/src/ai-computer-use.types.ts` |
| Provider adapters | `packages/voice-ai/src/computer-use/` |
| Native capture and input | `apps/desktop/src-tauri/src/platform/computer_use/` |
| Loop, permissions, routing | `apps/desktop/src/agents/computer-use/` |
| Settings and warning dialog | `apps/desktop/src/components/settings/AIAgentModeDialog.tsx` |
