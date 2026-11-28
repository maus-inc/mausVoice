# TASK (concise & accurate)

Implement and verify five issues in mausVoice desktop: #299 switch-row press transform, #300 saved-audio startup latency, #301 sidebar route prefetch, #307 version-tag overlap, #308 preview-popup eye toggle.

- [x] Verification+research per AGENTS.md (FULL-REVIEW.md + references read)
- [x] Regression audits + deep-refinement pass + i18n healing — `509c70a2`
- [x] Finding A (aborted-entry contract) + spec hardening — `78d94170`, `503a3987`
- [x] Native toolchain fetch + genuine `test:webdriver` 6/6 green
- [x] PR #319 created vs `arena/0.1.6-consolidation`; babysit rounds 1–8 (DeepSource, SonarCloud, CodeRabbit batch, Node 24 realm fix) all resolved
- [ ] Final babysit: Build Desktop (Windows)/(macOS) to green on `0df29189`, then report once
- MERGE strictly forbidden without the exact human approval wording
