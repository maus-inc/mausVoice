# Meeting Notes — Research

## Falsifiable research questions

1. How does the existing transcription session lifecycle work, and how can it
   be extended to capture timed segments?
2. Does Deepgram support diarization with the current WebSocket integration?
3. How are conversations created and linked to domain entities?
4. What is the database migration pattern for new tables?

## Findings

### 1. Transcription session lifecycle

Sessions implement `TranscriptionSession` interface (`src/types/transcription-session.types.ts`):
- `onRecordingStart(sampleRate)` — Initialize provider connection.
- Audio chunks flow via `listen("audio_chunk", ...)` event.
- `finalize(audio)` — Close connection, return `TranscriptionSessionResult`.
- `cleanup()` — Release resources.

The Deepgram session (`src/sessions/deepgram-transcription-session.ts`) already
supports interim results via `setInterimResultCallback()`. The WebSocket
response includes `words[]` with `start`, `end`, `punctuated_word`, and
(when diarization is enabled) `speaker` fields.

### 2. Deepgram diarization

Meeting sessions need per-word speaker labels, which Deepgram returns as
`speaker` per word in `words[]` once diarization is enabled on the session.
The current `buildDeepgramWebSocketUrl()` does NOT enable diarization. When
the meeting recording slice lands, it must opt into diarization per the
current Deepgram docs and cover both URL variants with tests before
consuming `words[].speaker`. (The exact parameter name was left
unpinned here on purpose: verify it against the live Deepgram docs at
implementation time rather than trusting a remembered flag.)

### 3. Conversation linking

Conversations are created via `conversation_create` Tauri command and stored in
`conversations` table. Chat messages reference `conversation_id`. There is no
existing FK from conversations to domain entities (transcriptions, meetings).
We add `meetingId` as metadata on the conversation.

### 4. Migration pattern

Migrations are `NNN_description.sql` files registered in `db/mod.rs`. Latest is
version 075. Next is 076. Tables use `id TEXT PRIMARY KEY`, timestamps as
INTEGER millis, FK with `ON DELETE CASCADE`.

## Source references

| Claim | Source |
|-------|--------|
| TranscriptionSession interface | `src/types/transcription-session.types.ts:26-34` |
| Deepgram WebSocket words format | `src/sessions/deepgram-transcription-session.ts:258` |
| Conversation schema | `src-tauri/src/db/migrations/063_conversations_and_chat_messages.sql` |
| Latest migration version | `src-tauri/src/db/mod.rs:580` (version 74/75) |
| Meeting types already defined | `src/types/meetings.types.ts` |
