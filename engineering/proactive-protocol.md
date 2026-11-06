# Proactive problem solving, authoritative elaboration

This document is the elaboration for the Proactive Problem Solving Protocol HARD CONSTRAINT in `AGENTS.md`. `AGENTS.md` now carries this protocol inline at full depth, so this file is a fallback rather than the only full copy. It is authoritative when `AGENTS.md` is truncated by a tooling limit (for example Codex at 32 KiB). Where the two differ, `AGENTS.md` governs, and the difference is a defect to fix here.

## Intent recognition

- Write 1-2 sentence hypothesis of underlying goal before editing.
- Treat initial message as evidence, not spec; consult repo context and `docs/decisions/`.
- Ambiguous intent: offer recommendation, not menu, and get confirmation.

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

## Proactive solving

- NEVER symptom-only; trace via 5 Whys, name architectural vs logical root cause.
- NEVER silently expand scope; use 3-point proposal (minimal risk, comprehensive file list, verification for class) with two options + recommendation, closed-world enumeration, wait for explicit confirmation.
- If human confirms minimal for multi-instance pattern, document remaining gap with follow-up issue.

## Enforcement detail

- Evidence gathering: parallel reads of file + consumers + tests + analogues; web search only when relevant and authorized, otherwise repo evidence + reason.
- Verification: tie every claim to tool output from this session; fresh-context re-read as verifier.
- Research Gate must include pattern class, instances, queries, sources, edge cases, failed attempts.
- PR description must include proposal + (when scope expanded) confirmation + class verification; when no expansion, state no expansion needed with evidence.
