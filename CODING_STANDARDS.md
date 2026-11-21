# Coding standards for mausVoice reviews

Read this entire document against the entire proposed merge, before **every** push. Review what will ship, including inherited commits in the PR, deletions, generated files, patches, tests, workflows and documentation. The unit of review is the behavior, not the changed line: follow it into unchanged callers and consumers. A passing lint or unit suite is evidence for a particular claim, not a substitute for this review.

For each numbered section, record either **verified** with concrete evidence, or **not applicable** with the reason tied to this diff. An untested applicable claim is not "not applicable". Fix a blocker or stop the push. Keep separate the things you observed, inferred, and still need a device, credential or independent reviewer to settle. [Running the gate](engineering/standards-review.md) explains the receipt; [the retrospective](reports/review-history-retrospective.md) links these rules to actual reviews and the next checks to build. `REVIEW.md` and `FULL-REVIEW.md` remain the review protocol.

## CS01. Resource ownership across time

For a recorder, stream, timer, listener, database lease or agent run, identify who can start it and **who has authority to stop it now**. A UI flag that says "idle" is not proof that a microphone is closed. Follow acquisition, publication, supersession, cancellation, failed stop and destruction. If an operation can fail after acquiring the resource, find the owner on that path too.

- Trace one interleaving in which A pauses at an `await`, B takes over, then A completes. A must neither publish its result into B nor tear down B's resources. Put the ownership check at the effect, not just at the start of the function.
- A deadline settles the waiter. What happens to the underlying operation, its callbacks and its late result? Stop accepting new work, release what this generation owns, and account for every already-started promise. A rejected stop can leave an active device; a `finally` that clears a flag is not a recovery policy.
- Evidence: pause the real handoff point with a deferred promise, start the replacement, then release or reject the first operation. Observe which handle was discarded, which listener can still fire, and what the next user sees. An arbitrary sleep is not an ordering guarantee.

## CS02. Durable data and contracts at boundaries

Follow one value from renderer action through repo, Tauri command, Rust handler and SQLite, then back through the read path. Identify the source of truth at each step. Compare the generated binding, actual serialized payload and runtime registration; a type or preview fake in isolation cannot establish the wire contract.

- Preserve the distinction between absent, explicitly cleared, empty and invalid. A partial write must not replace an unrelated field with a stale full-row snapshot. Check the order of durable success and publication to the store. On failure, specify which state is intentionally session-only and which is rolled back.
- Exercise upgrades with existing rows, not just a fresh schema. Check foreign keys, cascades, defaults, previously applied migrations, and what an older nullable value means to the new consumer. Do not repair an upgrade by silently wiping user data or editing a migration that has shipped.
- Evidence: start with a value unlike the default, write through the producer, then reload what **that write** produced. Include the failed write or deleted parent. A list fixture seeded independently of the update proves only that the reader accepts the fixture.

## CS03. Privacy, authority and consent at the effect

Name the data, recipient, authority and purpose before adding a network call, persistent write, diagnostic or support export. Dictation, clipboard contents, dictionary entries and signed URLs can identify someone without containing an API key. A developer log is still a disclosure.

- Check capture **and** delivery: a dictation made in private mode must not become eligible for storage because the mode later changed; a queued write must not revive data after a clear. Trace both directions of a preference change while work is pending.
- A user choosing a provider is not consent to send extra context, enable a billable field or use a different destination. Bind a remote operation to its authorized session and destination. Apply the same constraints to fallback, redirects, retries and preview as to the primary path.
- Evidence: carry a synthetic identifying value through the failing path. Verify the allowed operation still happened, then inspect the actual request, DB row, UI error and captured log as applicable. Prefer an operation, safe category and correlation ID over a truncated transcript or raw error object.

## CS04. Provider behavior and bounded work

Review the request the installed SDK sends, not the option name in the wrapper. Ask which layer owns retry, fallback, timeout, reconnect and cancellation. Count attempts over the entire user operation. A limit at each of two layers can multiply rather than bound the work.

- Distinguish transient failures, model-specific rejection, account-wide denial and user cancellation. Which can another attempt on this key actually fix? Does switching model or transport change data handling or price? An already-started stream is not interchangeable with a fresh request.
- Check batch and streaming paths, supported model families, the declared response format and the case where optional fields do not exist. Do not assume a private SDK field or deep-merge result survives an upgrade. Locate the pinned implementation or test the real SDK at its transport.
- Evidence: inject failing HTTP or socket I/O below the SDK, assert the outgoing shape or number of actual calls and the final outcome. Keep live, credentialed smoke tests separate. A raw-transcript fallback may be correct delivery and still be a failed cleanup.

## CS05. Platform and artifact parity

Separate the shared decision from the platform adapter. Compare GTK, AppKit, Win32, browser/preview and packaged Tauri at the same user action. Differences in focus, key dispatch, CSS vs physical pixels, paths and process teardown can make identical-looking code behave differently. Share the policy; preserve deliberate platform conventions at the edge.

- For a generated file, patch, model, sidecar or installer asset, follow its producer to the artifact the installed program actually loads. Check a clean build, an existing cached file and the supported OS/architecture. A byte count or a successful download is not an integrity check.
- Evidence: run the shared decision with opposite inputs. Compile the adapters for their targets. Name which target was actually run: Linux unit tests, a Windows type-check, a signed macOS launch and a real keyboard interaction establish different things. Do not upgrade one claim into the next.

## CS06. What the user can see, understand and operate

Check the rendered control and its effect, not just the token or component intended to render it. Walk from a supported starting state to the action and its outcome with pointer and keyboard. Inspect loading, success, empty, disabled, error and retry where they mean different things to the user.

- Verify focus ownership and return, accessible names, the real hit target, both color schemes, narrow windows, long translations and reduced motion. A caption next to a row is not proof that clicking it activates the row. A progress indicator is not proof that bootstrap completed.
- Compare copy, menu availability, settings defaults, permission prompts and docs to the reachable behavior. Include accessible labels in the message catalog. A "saved" state must distinguish a durable write from a preview or a failed write. Review SVGs in the component that actually renders each mark.
- Evidence: name the route, control, interaction and visible postcondition. Use the existing desktop WebDriver or preview harness at the appropriate boundary. A jsdom shape comparison is useful evidence for emitted attributes, not for contrast or native layout.

## CS07. A test must discriminate the promised behavior

For each important regression assertion, describe a plausible broken implementation and what the test observes that would change. Run the counterexample for a suspicious oracle. Revert the mutation and run green again. Exact source text is the contract for a verbatim prompt or generated-byte drift; it is not the contract for a key press, network budget or persisted value.

- Use an oracle independent of the implementation. Do not compare a fake's prearranged output to its input, a string to a suffix already present, or a helper-generated expectation to the same helper. Assert against the specific instance, message, generation or rendered element, not a match anywhere in the file.
- Demonstrate the precondition. If another guard also blocks a request, make that guard allow it. If a test says the agent continues after a failed tool write, observe the next assistant message. Logging the failure and resolving normally is compatible with stopping early.
- Give fakes only the authority the real dependency has: enforce connection states, DB delete behavior and legal event order. Use an actual SDK, migration or reducer where reimplementing it in the fixture would answer the very question under test. Keep a useful negative control; do not discard assertions just because the environment is inconvenient.

## CS08. A gate must judge the change it claims to judge

Trace the trigger, inputs, executable, scope and exit status to the merge decision. Check paths that affect the output indirectly: a workspace package, pinned patch, generator, lockfile, feature flag or workflow. A skipped job, empty selection, old head or green check on the wrong base is not evidence for this PR.

- Run a negative fixture through the actual entry point. The gate must reject the defect and accept a valid variation. If checking syntax, use the format's reader where possible; comments, string literals and formatting must not masquerade as active code.
- Separate policy execution from PR-controlled data. Read event fields as data, use least privilege and check the immutable base policy when one exists. Document any first-install exception. A receipt proves what was attested for which commits; it cannot prove the reviewer read carefully.
- Treat a review comment as a hypothesis. Reproduce it on the current tree, find sibling instances, and record fixed, already covered, not applicable or unresolved with evidence. A bot declining to review a large diff, an approval with no analysis, or a resolved conversation does not establish correctness.
