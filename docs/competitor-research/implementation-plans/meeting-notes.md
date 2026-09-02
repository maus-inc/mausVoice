# Meeting Notes — Implementation Plan

**Category:** Feature expansion
**Stack position:** 2 (parent: expansion/1-shared-foundations)
**Branch:** `expansion/2-meeting-notes`
**Feature flag:** `meetingNotesEnabled` (default: false)

---

## Goal

Deliver a separate meeting domain that records microphone audio (and optionally
system audio), transcribes it with timed segments, supports speaker diarization
via Deepgram, generates AI summaries, provides Ask AI over meeting notes, and
supports export. This is the single largest gap vs Vowen and Wispr Flow.

## Non-goals

- System audio capture in v1 (documented as v2). Microphone-only first.
- Local whisper diarization (cloud-only via Deepgram Nova-3).
- Real-time meeting auto-detection.
- Obsidian/Notion/Slack export (connectors PR handles those).

---

## Verified competitor behavior (citations)

| Competitor | Behavior | Source | Confidence |
|------------|----------|--------|------------|
| Vowen | Silent capture (no bot) of Zoom/Teams/Meet/Slack/Discord/Webex/browser/system audio | docs.vowen.ai | High |
| Vowen | Speaker diarization (Pro): on-device or cloud; 44 summary templates + custom | docs.vowen.ai | High |
| Vowen | Live transcript, "Mark important", Ask AI, export PDF/TXT/MD/SRT/VTT/audio | docs.vowen.ai | High |
| Wispr Flow | On-device recording, no bot joins; works with any meeting app + in-person | docs.wisprflow.ai | High |
| Wispr Flow | Speaker identification by name; Flow Summaries; Ask Wispr across meetings | docs.wisprflow.ai | High |
| TypeWhisper | Calendar-aware meeting automation (macOS Premium) | typewhisper.com docs | High |

---

## Current mausVoice behavior

- No meeting domain exists.
- Dictation records mic audio only, no timed segments stored.
- No diarization support.
- No meeting summaries.
- No meeting-specific chat.
- Conversations exist but are not tied to meetings.

---

## Architecture constraints (from AGENTS.md)

- Rust is the API, TypeScript is the brain.
- Single source of truth: Zustand + Immer.
- Data flow: Event -> Action -> Repo -> Tauri command -> native/storage.
- New Tauri commands: define in `commands.rs`, register in `app.rs`, expose via
  Specta, run `pnpm gen:bindings`, wrap in a repo, call from an action.
- Forward-only migrations in `src-tauri/src/db/migrations/`, registered in
  `db/mod.rs`. Never renumber.
- No telemetry, no logging of audio/transcript/prompt/token/secret content.
- No non-loopback network listeners.
- No raw audio in SQLite.

---

## Required migrations

1. `076_meetings.sql` — `meetings`, `meeting_segments`, `meeting_speakers` tables.

## Database schema

```sql
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    summary TEXT,
    transcript TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'microphone'
);

CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings (created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_segments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    start_time_ms INTEGER NOT NULL,
    end_time_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    confidence REAL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meeting_segments_meeting_start
    ON meeting_segments (meeting_id, start_time_ms ASC);

CREATE TABLE IF NOT EXISTS meeting_speakers (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    name TEXT NOT NULL,
    label TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
```

## Rust domain types

- `domain/meeting.rs` — `Meeting`, `MeetingSegment`, `MeetingSpeaker` structs.
- `db/meeting_queries.rs` — CRUD queries for all three tables.

## Tauri commands

- `meeting_create` — Insert a new meeting row.
- `meeting_get` — Fetch meeting by id with segments and speakers.
- `meeting_list` — List meetings ordered by created_at desc.
- `meeting_update` — Update meeting fields (title, status, summary, transcript).
- `meeting_delete` — Delete meeting (cascades to segments/speakers).
- `meeting_segment_insert` — Insert a batch of segments.
- `meeting_speaker_insert` — Insert a batch of speakers.

## TypeScript repos

- `repos/meeting.repo.ts` — `BaseMeetingRepo` / `LocalMeetingRepo`.

## TypeScript actions

- `actions/meeting.actions.ts` — `startMeetingRecording()`,
  `stopMeetingRecording()`, `generateMeetingSummary()`,
  `createMeetingConversation()`.

## Meeting transcription session

- `sessions/meeting-transcription-session.ts` — Implements
  `TranscriptionSession`. Wraps Deepgram session, captures timed segments
  from `words[]` array in WebSocket messages. Groups consecutive words by
  speaker into segments.

## AI summary

- Uses existing `generate-text.repo.ts` pattern.
- System prompt: meeting summary template.
- User prompt: full transcript with segment timestamps.
- Output: structured JSON with summary, action items, key points.

## Ask AI

- On meeting completion, auto-create a `Conversation` with title = meeting title.
- Pre-populate conversation context with meeting transcript.
- User messages appended as usual.

## Acceptance criteria

1. Meeting tables created via migration 076.
2. Meeting CRUD commands registered and reachable from TypeScript.
3. Meeting recording session captures timed segments from Deepgram.
4. AI summary generation produces structured output.
5. Meeting-linked conversation created on completion.
6. Feature gated behind `meetingNotesEnabled` flag.
7. Incognito mode suppresses meeting persistence.
8. No existing dictation/transcription test regresses.
9. Type check, lint, unit tests, i18n all pass.

## Risks, alternatives, unknowns, rejected approaches

- **Risk**: Deepgram diarization requires Nova-3 model. Mitigation: gate
  diarization behind provider capability check.
- **Alternative**: Store segments as JSON blob in meetings table. Rejected:
  normalized tables allow per-segment queries and are consistent with existing
  patterns (conversations + chat_messages).
- **Unknown**: Whether whisper.cpp sidecar can return segment timestamps.
  Mitigation: cloud-only for v1.
- **Rejected**: Building a full meeting UI in this PR. Backend + types only.

## Handoff for next polecat

After this PR is green, the Local Automation PR (`expansion/3-local-automation`)
can build on:
- Meeting domain types and repos.
- The `meeting.completed` webhook event type.
- The meeting summary generation pattern.
