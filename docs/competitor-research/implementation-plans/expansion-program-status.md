# Expansion program status

## Program overview

The mausVoice expansion program adds competitor-derived features from Vowen, Wispr Flow, and TypeWhisper. The program produces implementation plans in this directory, then executes them as a sequence of PRs.

## Goals

- Add meeting notes with speaker diarization and summaries
- Add local automation through an HTTP API, CLI, and MCP server
- Add connectors and webhooks for external services
- Add translation and interactive snippets
- Add hands-free toggle and voice-triggered workflows

## Categories

| Category       | Description                                            | Status      |
| -------------- | ------------------------------------------------------ | ----------- |
| Research       | Competitor evidence and mausVoice baseline inspection  | In progress |
| Planning       | Implementation plans, decisions, and verification docs | Blocked     |
| Implementation | Code, migrations, and tests                            | Pending     |
| Review         | Internal review and review-bot feedback                | Pending     |
| Complete       | Merged and shipped                                     | Pending     |

## Blockers

| Blocker                                                       | Impact                                  | Resolution                                  |
| ------------------------------------------------------------- | --------------------------------------- | ------------------------------------------- |
| The `Expansion` label does not exist on the GitHub repository | Cannot file PRs with the expected label | Create the label in the repository settings |

The missing `Expansion` label blocks filing PRs. It does not block research or planning work. This file tracks program progress independently of that blocker.

## PR tracking

| PR   | Category    | Status | Notes               |
| ---- | ----------- | ------ | ------------------- |
| #144 | Foundations | Open   | Program base branch |

## CI and quality gate tracking

| Gate           | Command                                 | Status      | Notes                             |
| -------------- | --------------------------------------- | ----------- | --------------------------------- |
| Type check     | `pnpm --filter desktop check-types`     | Not started | Runs against each category branch |
| Lint           | `pnpm --filter desktop lint`            | Not started | Runs against each category branch |
| Unit tests     | `pnpm --filter desktop test`            | Not started | Runs against each category branch |
| Voice-ai tests | `pnpm --filter @maus-inc/voice-ai test` | Not started | Runs against each category branch |
| Agent tests    | `pnpm --filter @repo/agent test`        | Not started | Runs against each category branch |

Run the CI gate commands from the repository root on each category branch before marking a category as Complete. Mark each gate as Passed or Failed in the table above.
