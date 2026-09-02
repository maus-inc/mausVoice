# Meeting Notes — Decisions

## Decision 1: Three-table schema for meetings

**Choice:** `meetings`, `meeting_segments`, `meeting_speakers` as separate
tables with FK relationships and `ON DELETE CASCADE`.

**Rationale:** Normalized schema allows per-segment queries, consistent with
existing `conversations` + `chat_messages` pattern. JSON blob alternative
would prevent efficient segment-level queries.

## Decision 2: Extend Deepgram session for timed segments

**Choice:** Create `MeetingTranscriptionSession` that wraps the existing
Deepgram session and captures `words[]` from WebSocket messages.

**Rationale:** Reuses existing Deepgram integration. Timed segments are
captured during streaming, not post-processing. Minimal new code.

## Decision 3: Cloud-only diarization via Deepgram Nova-3

**Choice:** Gate diarization behind Deepgram provider + `diarize=true`
parameter. No local whisper diarization in v1.

**Rationale:** Deepgram Nova-3 reliably supports diarization. Local whisper
has no built-in diarization. Platform-specific system audio capture is a
separate concern.

## Decision 4: Meeting-linked conversation via metadata

**Choice:** Store `meetingId` in conversation metadata (not a new FK column).
Auto-create conversation on meeting completion.

**Rationale:** Avoids schema changes to existing `conversations` table.
Metadata field is sufficient for lookup. Conversation is pre-populated with
meeting transcript as context.

## Decision 5: Summary via existing generate-text pattern

**Choice:** Add `summarizeMeeting()` action using `generate-text.repo.ts` with
a meeting-specific system prompt and JSON schema for structured output.

**Rationale:** Reuses existing LLM routing and provider abstraction. No new
infrastructure needed.
