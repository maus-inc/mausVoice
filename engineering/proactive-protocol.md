# Proactive problem solving, authoritative elaboration

This document is the elaboration for the Proactive Problem Solving Protocol HARD CONSTRAINT in `AGENTS.md`. `AGENTS.md` now carries this protocol inline at full depth, so this file is a fallback rather than the only full copy. It is authoritative when `AGENTS.md` is truncated by a tooling limit (for example Codex at 32 KiB). Where the two differ, `AGENTS.md` governs, and the difference is a defect to fix here.

## Intent recognition

- Write 1-2 sentence hypothesis of underlying goal before editing.
- Treat initial message as evidence, not spec; consult repo context and `docs/decisions/`.
- If intent is materially ambiguous, explain which decision changes the outcome and recommend a choice. Otherwise proceed within the stated scope.

## Autonomous execution

The user's request authorizes the work it describes. Assess risk, plan, run the depth pass, implement, verify and report in the same task. Do not pause for discussion, plan approval or a separate `go` on a request to implement, refine or continue. Ask only about material ambiguity, proposed scope expansion or an action repository policy reserves for the human. Merging still requires the exact human confirmation in `AGENTS.md`.

For a repository change that is not local-only, start with a draft PR as soon as the scope, acceptance criteria and base are clear. Push the first scoped commit after its pre-push checks and open or reuse the draft against the actual base. Keep subsequent verified checkpoints on that remote branch. A draft saves work; it does not declare the work ready for review or merge.

Include one folded `Draft roadmap` from the first push. Give the next agent the authorized outcome, milestone status, next action and any blocker that changes it. Reconcile it with each push: replace stale scope or initiatives in place, prune finished detail and link to evidence instead of repeating history.

## Queue discipline

Process independent accepted tasks in FIFO order. Apply corrections and clarifications to the active task immediately. Queue newly discovered independent work for consideration; execute it only when authorized.

## Efficient investigation

Inspect the current source, its callers and tests together. Treat prior conversations, summaries and remembered paths as leads. Cite exact `path:line` references for repository claims and recheck them after edits. If you cannot inspect the source or run a check, state what you could not verify. Batch related edits, run focused checks after meaningful changes and complete the final Verification Gate before handoff.

## Delegation

Delegate implementation or review when a suitable agent is available and it helps the task. Otherwise proceed yourself. Report only delegation that occurred. The orchestrator owns integration, review and verification.

## Pattern matching

- Iterative discovery: after salient instance, re-search conditioned on findings.
- Name class explicitly, check boundaries bidirectionally, record instances + evidence in Research Gate.
- PR without class name is incomplete.

## Depth pass

- Before acting on a plan-first or non-trivial task, run the four-question depth pass from
  `.agents/skills/be-ambitious/SKILL.md`. Name the field, then answer what an expert would do
  that the task did not ask for, which raw material they would start from, which named methods
  and tools fit, and what other than the agent or the human would show the result is right.
- Run it, do not offer it. No rewritten prompt handed to the human, no question about whether to
  go deeper, no stopping after the pass. The task continues into execution in the same turn.
- Gate the fourth answer. Run the external check and attach the result, or label the claim as a
  hypothesis awaiting verification with what would settle it, or downgrade the work to a plan
  awaiting verification when the answer is empty. Never fabricate a check, a source or a result.
  A stated cannot verify now passes. An invented verification fails. When a sandbox gap is what
  stops the check, name its number from `engineering/sandbox-coverage-gaps.md`, or its heading
  for the accepted gaps that carry no number, not just the word sandbox.
- Record the pass. The four answers and the gate result per claim go in the report, so a run
  that loses context mid-way still leaves the evidence behind.
- Depth is not scope. A move that makes the job larger goes through the confirmation rule below.
  A move that makes the same job better does not need permission.

## Learning from failures

Trace the failure through the 5 Whys. Identify the actionable cause in the architecture or logic and fix it rather than treating a symptom. Record recurring workflow failures and improvements. Update shared instructions only when the evidence shows a repeatable systemic gap.

## Scope control

If the fix would expand scope, present the minimal option and its recurrence risk, the comprehensive option and its file list, and the check that would distinguish a class-wide fix. Recommend one. Wait for explicit confirmation of the additional actions before taking them. If the human chooses the minimal fix, document the remaining instances as a gap.

## Enforcement detail

- Evidence gathering: parallel reads of file + consumers + tests + analogues; web search only when relevant and authorized, otherwise repo evidence + reason.
- Verification: tie every claim to tool output from this session; fresh-context re-read as verifier.
- Research Gate must include pattern class, instances, queries, sources, edge cases, failed attempts.
- PR description must include proposal + (when scope expanded) confirmation + class verification; when no expansion, state no expansion needed with evidence.
