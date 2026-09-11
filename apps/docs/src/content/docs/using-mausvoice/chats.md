---
title: "Chats"
description: "Continue assistant conversations, review tool activity, and manage locally stored chat history."
sidebar:
  order: 11
---

**Chats** is the main-window view of the experimental assistant. The navigation item appears only after **Settings → Processing → Assistant mode → Assistant mode** is enabled.

## Start or continue a conversation

Choose **Chats**, then use **New chat** (`+`) to create a conversation. Type in the composer and press Enter or choose the send button; use Shift+Enter for a line break. A voice-assistant session also creates a conversation, and the **Open chat** shortcut opens the current pill conversation in this view.

A conversation stays listed as **New conversation** until you send its first message. The sidebar then names it from that message and orders the list by latest activity. Each row shows the conversation date and switches to the time when you hover over it or open it.

The response streams into the conversation. Tool activity appears alongside model output, and a tool that needs access pauses for a permission card. Review its parameters and reason, then choose **Deny**, **Allow**, or **Always allow**. Denial returns a failed tool result to the assistant; it does not undo an action that was already approved and completed.

See [Assistant mode](../assistant-mode/) before approving screen reads, paste operations, or terminal commands.

## What is stored and sent

Conversations, user messages, assistant responses, and tool-result metadata are stored in the local SQLite database. They survive app restarts and are separate from transcription-history rows. Sending another message rebuilds the conversation context and sends the relevant message history to the assistant provider selected in Assistant mode. Tool output can therefore become part of later provider requests.

A conversation's overflow menu offers **Delete**. Deleting it removes the local conversation and all of its chat messages. **Settings → Danger zone → Clear local data** also clears the `conversations` and `chat_messages` tables. Neither action can retract information already sent to an external model provider or reverse filesystem changes made by a tool.

## Safe operating habits

- Begin a new conversation when prior context should not influence the next task.
- Do not place secrets in a chat unless the configured provider and task require them.
- Read command and paste parameters before approval; model prose is not proof that the tool did what you intended.
- Prefer one-time **Allow** over **Always allow**, especially for terminal access.
- Verify results in the destination application or filesystem before relying on them.

If a message fails, confirm Assistant mode is set to **API**, its selected generative provider credential is valid, and any custom endpoint is reachable. A transcription provider alone does not configure chat responses.
