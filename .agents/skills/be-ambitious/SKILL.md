---
name: be-ambitious
description: >
  Turn a task into a deeper version of itself, not a bigger one. Name what a top
  professional in the field would do that the task does not ask for, the rawest
  source material they would start from, the specific methods and tools they
  would use, and what other than the agent or the user would show the result is
  right. Then pass that last answer through a verification gate: run it now, or
  label it as a hypothesis awaiting verification. Fires on its own for every
  plan-first or non-trivial task, and the task continues into execution.
---

# Be ambitious

Adapted from a prompt shared by Felix Rieseberg (Anthropic):

> I want a deeper version of this task, not a bigger one. Before rewriting it:
> (1) say what a top professional in this field would do here that I'm not
> asking for; (2) name the rawest material they would start from instead of
> what has already been digested for me; (3) name the specific methods and
> tools they would use; (4) say what, other than you or me, would show the
> result is right. Then rewrite my prompt to ask for exactly that.

## Provenance and the two local edits

Source: `DannyMac180/skills`, folder `be-ambitious`, read from the head of pull request 11,
branch `add-verification-gate`, commit `56be33ba3e047db18e304742d48ec8353c3b5a9a`, on
2026-11-05. That pull request adds the verification gate for the fourth answer, and this file
keeps it.

Two local edits, deliberate, so this skill has no `skills-lock.json` entry and
`verify-skills.mjs` reports it unrecorded next to `unslop`, `find-skills` and `ui-capture`.

1. It fires without being invoked. There is no `/be-ambitious` trigger and no offer. The depth
   pass runs as part of the work whenever the task is plan-first or the prompt is being shaped.
2. It does not stop after the rewrite. The task continues into execution, and the gate result
   travels with the work rather than ending the turn.

Upstream stops on purpose, because it is a task shaper rather than an executor. In this
repository the shaper and the executor are the same agent, so a stop would be a lost turn. The
gate is what keeps the faster path honest.

## Deeper, not bigger

Keep the user's goal and scope. Depth means a higher standard for the same outcome: better
sources, sharper methods, real verification. Do not add deliverables, features or side quests.
If a move would make the job larger rather than better, drop it. Scope that genuinely belongs to
the task still goes through the confirmation rule in the proactive protocol. Depth never
authorises expansion.

## The four questions

Name the field first, for example desktop audio capture, transcription pipeline work, or Tauri
IPC hardening. Then answer the four questions for that field, concretely. Name the actual thing,
not the category.

1. **What a top professional would do that was not asked for.** The two or three moves that
   separate expert work from competent work here, such as stating the decision the work serves,
   reproducing before fixing, or writing the counter-argument.
2. **The rawest material.** The primary sources they would start from instead of summaries: the
   file and the migration, not the schema diagram; the log and the reproduction, not the bug
   report; the upstream source and the changelog, not the tutorial; the recording, not the
   description of the recording. Say where it lives in this repository when you know.
3. **Specific methods and tools.** Named techniques, libraries, commands or harnesses, and why
   each fits this task. In this repository that means the actual gate command, the actual
   script under `scripts/ci`, or the actual test file, not a genre of tool.
4. **What, other than the agent or the user, would show it is right.** An external check: a
   test suite, a reproduction, ground-truth data, a known answer to compare against, a
   measurement, a reviewer, or a real user's behaviour. Say what result counts as a pass and
   what counts as a failure.

If you do not know the field well enough to answer, say so rather than inventing a source or a
tool. An honest gap is depth. A confident invention is not.

## Verification gate

Question 4 is the line between a plan and a result. Do not certify what you have not checked.
After the four answers, the fourth one must pass one of three exits.

- **Verifiable now.** When the check can be run with what is at hand, run it inside the same
  turn and attach the result. Only then may the work be called deeper in fact.
- **Not verifiable now.** When it cannot be run, because there is no data, no access, no device,
  or the run is unsafe or too expensive, label the claim as a hypothesis awaiting verification
  and name what would settle it. Do not present it as a settled criterion.
- **Empty.** When the fourth answer is empty, do not call the result deeper. Call it a plan
  awaiting verification.

Never fabricate a check, a source or a result to satisfy this gate. A stated cannot verify now
is a pass. An invented verification is a failure.

In a restricted sandbox, `engineering/sandbox-coverage-gaps.md` names which checks cannot run
and why, so the label can be specific rather than vague. A gap number is better evidence than
the word unavailable.

## Execute, and resume

No offer, no prompt rewrite handed back, no question about whether to go deeper. Run the pass,
then continue into the task in the same turn.

- If the gate found a runnable check, run it as part of the work rather than proposing it.
- If the gate found nothing runnable, name the hypothesis, continue, and revisit it when the
  missing input arrives.
- If the work stops because a decision belongs to the human, stop for that decision only, and
  resume from the same point when the answer arrives. Do not re-run the depth pass to fill the
  pause.

## Reporting

One short block, in the response for the human or under a collapsible heading in the pull
request: the field, the three or four moves taken that were not asked for, the sources started
from, the methods used, and the gate result per claim, run or labelled. Keep it to the facts
that changed the work. A depth pass that produced nothing new is worth one line, not a section.
