# Fallow for agents and pull requests

Fallow is a deterministic, MIT-licensed static analyzer for JavaScript,
TypeScript, and supported styles. It builds a module graph and reports unused
code, duplication, complexity, cycles, and styling findings. Its local CLI does
not need an account. This repository pins Fallow 3.38.1 in `package.json` and
`pnpm-lock.yaml`.

## Required workflow

Install dependencies with `pnpm install --frozen-lockfile`. Before final handoff,
commit, and push, agents must load `.agents/skills/fallow/SKILL.md` and run:

```sh
pnpm --silent run fallow:audit --base <target-ref> --format json --quiet
```

Replace `<target-ref>` with the actual pull request target or its base commit.
For example, use `origin/main` only when the work targets main. Make sure the
ref is present and includes the merge base. Re-run after the last change and
report the base, verdict, and exit status. Fallow includes untracked files in
its local audit. Do not assume that a successful run on an earlier tree covers
later edits.

`audit` compares findings in changed files against the base snapshot. The
`new-only` gate fails on introduced error-severity findings, not all existing
findings in a touched file. Exit 0 can mean either pass or warn. Exit 1 means
an enforced finding failed the gate. Exit 2 means the tool could not complete,
for example because the base ref is invalid. Read warnings and diagnostics,
including stderr. Do not use `--brief` or `fallow review` as the gate because
review exits 0 even when it reports a failing verdict.

The docs homepage uses named, decorative card artwork elements instead of
position-dependent selectors. The docs contract and built-homepage tests check
that each card keeps its intended artwork and that the elements do not add a
paragraph to the text flow. This avoids tying artwork to card order while
preserving its placement and both color themes.

For diff reviews, load `.agents/skills/fallow-review/SKILL.md` and also run:

```sh
pnpm exec fallow review --base <target-ref> --format json --quiet
```

Treat both reports as evidence, not proof that a deletion is safe. Check dynamic
imports, generated bindings, public APIs, framework conventions, and external
consumers. Use `pnpm exec fallow dead-code --trace <file>:<export>` or
`--trace-dependency <name>` to investigate. Preview any automatic fix before
applying it, and review the diff and tests. Do not silence a finding with a
broad ignore or disable a rule to make the check pass. Explain any justified
narrow suppression in the change.

Fallow cannot infer the computed Vite preview aliases, WebdriverIO's spec
pattern, or the GitHub Actions invocation of
`scripts/ci/check-gitleaks-config.test.mjs`. The standalone docs card generator
and badge generator are manually run tools, not imported modules.
`.fallowrc.json` identifies these individual entry points without excluding code.
The Fallow test checks the alias list and the other known entries against the
analyzer's discovered entries. Update the explicit list when adding an entry.

The PR workflow checks out the PR head, fetches history, and audits against the
GitHub-provided base SHA. It runs for every PR target, including stacked PRs.
`pnpm run test:fallow` checks that inherited findings do not fail the gate,
new untracked dead code does fail, an invalid base is an error, unchanged CSS
findings remain inherited after line shifts, the module graph has no
circular dependencies, and the configured architecture and runtime-call policies
reject introduced violations while allowing the preview's desktop imports. The line-shift fixture guards a Fallow 3.38 attribution
fix that prevents unchanged styling advisories being reported as new. A maintainer
must select **Fallow / Changed-code audit** as a required status check in GitHub
branch protection or a ruleset. A workflow file alone cannot require a check before
merge. Local instructions are not a technical barrier against bypassing them.

## Architecture and runtime-call policy

Fallow checks three source zones: shared package sources under `packages/*/src`,
`apps/desktop/src`, and `apps/preview/src`. Shared code must not import either
application; desktop code may import shared code but not preview code; preview
may import both. This models the actual preview reuse of desktop source. The
policy applies only to imports Fallow resolves between those zones: scripts,
docs, Rust, and other unmatched paths are not covered, and package exports or
other dynamic loading still need review. The configuration does not claim full
file coverage.

The boundary policy rejects direct calls to `eval`, `globalThis.eval`,
`Function`, and `globalThis.Function` in these zones, including their tests. Use structured parsing and explicit dispatch
instead. This is a syntactic guard, not proof that dynamic code execution is
impossible: Fallow 3.38.1 does not match constructor forms such as
`new Function(...)` or aliased/rebound callees. Other checks and code review
remain necessary. `pnpm run test:fallow` exercises both policies in an isolated
repository and confirms that introduced violations fail the same `new-only`
audit used by the PR gate. The fixture starts from a base without this
configuration, so it also exercises first-PR rollout. A rule-pack file newly
added in this PR cannot be used instead: Fallow 3.38.1 looks for it in the base
snapshot too and exits 2 when it is absent there. Keep the inline policy so the
required gate remains usable against the actual target commit.

## Security scan limits

The optional security scan reports syntactic candidates, not proof of an
exploit or of safety. For example, Speaches accepts an explicitly configured
endpoint. Its shared request helper hides transport errors that can echo
private audio or URL data and refuses redirects, including a caller-supplied
`follow` mode. The desktop caller supplies `secureFetch`, which enforces that
policy for native and browser transports. Aldea, Deepgram, ElevenLabs, xAI and
Gemini private audio/text requests likewise request `redirect: "error"`;
arbitrary injected transports must honor that option. Gemini, Deepgram,
ElevenLabs and xAI sanitize transport exceptions rather than exposing arbitrary
private request or response fragments, while preserving numeric HTTP status and
`HttpError` retry hints. A caller's explicit abort reason is preserved when it
passes the signal directly; an unrelated transport cancellation keeps its
`AbortError` name but not its original message or object identity. Deepgram,
ElevenLabs and xAI transcription also pass the signal through retry waits,
transport and JSON reads; xAI speech and Gemini additionally stop waiting for
stalled body reads. Late unreturned responses are cancelled without awaiting the
body's cancellation. Gemini accepts resumable upload URLs only on the exact `generativelanguage.googleapis.com` or
`storage.googleapis.com` HTTPS origins, and credential-bearing file URLs only
on the exact Gemini API origin. An unexpected upload origin falls back to
inline audio; large recordings may then exceed the provider's inline limit. A
new provider upload origin requires an explicit privacy review before it is
added, not a wildcard. A redirect that preserves the method
can otherwise replay the body to another origin, even when authorization headers
are stripped. Fallow may not resolve an indirect transport call, so an absent
network candidate is not evidence that the endpoint is safe. Review the actual transport, configuration trust, and
redirect behavior rather than treating the count as a security guarantee.
Model discovery similarly wraps its injected transport to prevent URL and
response-fragment leaks; the desktop paths still use `secureFetch` or the
saved-credential native transport. Picker probes stop waiting for uncooperative
fetches and JSON reads when cancelled, discard late responses and release abort
listeners. Availability probes discard their unused bodies. Inspect these
indirect calls as network sinks even if the scan does not identify them.

## Protective dependency overrides

Fallow reports an override as unused when no current workspace dependency or
lockfile package matches its target. That is not, by itself, evidence that a
security override is safe to remove. The guards for `@hono/node-server`,
`@protobufjs/utf8`, `qs`, and `hono` also prevent future vulnerable transitive
resolutions. An isolated pnpm 10.34.5 fixture requesting the affected versions
confirmed that each resolves outside its vulnerable range with these overrides.
Keep the guards unless an equivalent install-time protection is established and
verified; do not add artificial dependencies or hide the findings.

## Research and first scan

The initial local scan used Fallow 3.37.0 on the checkout based on
`5ba53332fd7582d23a472d1d0895a9c0dc776cc5`, with dependencies installed and the
new Fallow dependency present. It reported 266 dead-code and dependency
findings, including 32 unused files, 116 unused exports, and 20 cycles. The
health pass reported 226 functions above its configured thresholds. The
duplication pass reported 64 clone groups and about 1.63% duplicated lines
across its analyzed files. These are candidates, not verified defects. The
scan did not use runtime coverage. Bare JSON output is informational and exits
0 on findings unless a gate is explicitly enforced.

The scan also reported limits that need investigation before relying on these
counts for cleanup:

- The initial scan found an absent `apps/firebase/functions` workspace. It is
  now removed from `pnpm-workspace.yaml`, so that path no longer makes catalog
  analysis incomplete.
- Six workspace glob matches are Rust or font directories without a
  `package.json`. Fallow marked workspace analysis as degraded.
- Three minified vendor files were excluded by Fallow's default ignore rules.
- The initial scan had no configured architecture boundaries or rule packs.
  The current configuration adds the scoped boundary policies described above;
  rule packs remain unconfigured. A zero count is not evidence about files or
  dynamic calls outside their scope.
- The checkout was shallow, so churn and change-coupling data were incomplete.
  CI fetches full history for the PR gate.
- Fallow initially warned about an invalid inferred entry pattern involving
  `apps/docs/docsBase}assets/mausvoice-banner.png`. The docs now construct the
  social image URL with `URL`, and CI verifies the generated URL; the warning
  no longer appears in the current-tree scan. An audit against the original
  base can still print it while analyzing the base snapshot.

The Hono security overrides were consolidated to `hono@<4.12.25` →
`>=4.12.25`. That range covers the six older, narrower Hono overrides without
weakening their minimum versions. Regenerating the lockfile changed only those
six override entries, and a frozen install passed. The remaining transitive
security overrides should not be removed solely because Fallow cannot see a
current direct dependency.

The OpenAI 4.104.0 package declares `FileFromPathOptions` twice in
`_shims/index.d.ts`. TypeScript 5's `skipLibCheck` hides the duplicate, but
Fallow's TypeScript 7 companion treats it as a blocking bind diagnostic. The
pnpm patch removes one identical declaration and keeps the other and its
public signatures. `test:fallow` checks the installed declaration. Reassess the
patch when upgrading the SDK. With the patch, a type-aware symbol-impact query
for `BaseGenerateTextRepo.streamChat` completes and identifies its consumer in
`run-agent.ts`. Whole-project type-aware analysis remains partial and also
reports private type leaks. It is not the default PR gate.

Fallow does not analyze Rust or prove runtime use. Its default analysis is
syntactic and can miss dynamic behavior and external consumers. Keep the
existing Rust, lint, type, test, formatting, and security checks. Optional
runtime coverage and semantic analysis require separate setup; neither is
needed for this gate. No telemetry or cloud service is enabled by this change.

Sources consulted on 2026-10-29:

- [Fallow repository](https://github.com/fallow-rs/fallow)
- [Audit behavior and exit codes](https://docs.fallow.tools/cli/audit)
- [Workspace detection](https://docs.fallow.tools/configuration/workspaces)
- [Known analysis limitations](https://docs.fallow.tools/analysis/limitations)
- [Agent integration](https://docs.fallow.tools/integrations/mcp)
- [Fallow agent skills](https://github.com/fallow-rs/fallow-skills)
