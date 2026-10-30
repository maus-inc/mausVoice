<!-- GENERATED FILE — DO NOT EDIT; source: skill/references/patterns + rules/rules.json -->

# Reference Index

This index is generated. Route by the decision you face, then open the pattern.
For exact component props and imports, use the sibling `fluentui` skill
(for example [Button](fluentui:references/components/button.md)).

## Decisions

| Decision | Patterns | Rules |
| --- | --- | --- |
| `command-scope` | PAT-001 | RULE-001, RULE-002, RULE-003 |
| `data-processing-location` | PAT-002 | RULE-010, RULE-011, RULE-012, RULE-016, RULE-031, RULE-032, RULE-033, RULE-034, RULE-035, RULE-036 |
| `data-resilience` | PAT-002, PAT-008 | RULE-003, RULE-010, RULE-011, RULE-012, RULE-015, RULE-016, RULE-031, RULE-032, RULE-033, RULE-034, RULE-035, RULE-036 |
| `data-surface` | PAT-002 | RULE-010, RULE-011, RULE-012, RULE-016, RULE-031, RULE-032, RULE-033, RULE-034, RULE-035, RULE-036 |
| `edit-surface` | PAT-005 | RULE-008, RULE-009, RULE-029 |
| `feedback-channel` | PAT-008 | RULE-003, RULE-015, RULE-016 |
| `field-annotation` | PAT-004 | RULE-005, RULE-006, RULE-007, RULE-029, RULE-030, RULE-037, RULE-038, RULE-039, RULE-040, RULE-041, RULE-042 |
| `form-layout` | PAT-004 | RULE-005, RULE-006, RULE-007, RULE-029, RULE-030, RULE-037, RULE-038, RULE-039, RULE-040, RULE-041, RULE-042 |
| `modal-behavior` | PAT-005 | RULE-008, RULE-009, RULE-029 |
| `navigation-model` | PAT-001, PAT-006 | RULE-001, RULE-002, RULE-003, RULE-013, RULE-014 |
| `permission-state` | PAT-003, PAT-008 | RULE-003, RULE-015, RULE-016, RULE-029 |
| `progressive-disclosure` | PAT-006 | RULE-013, RULE-014 |
| `row-activation` | PAT-002 | RULE-010, RULE-011, RULE-012, RULE-016, RULE-031, RULE-032, RULE-033, RULE-034, RULE-035, RULE-036 |
| `save-model` | PAT-007 | RULE-029, RULE-030 |
| `selection-scope` | PAT-002 | RULE-010, RULE-011, RULE-012, RULE-016, RULE-031, RULE-032, RULE-033, RULE-034, RULE-035, RULE-036 |
| `submit-feedback` | PAT-004, PAT-007 | RULE-005, RULE-006, RULE-007, RULE-029, RULE-030, RULE-037, RULE-038, RULE-039, RULE-040, RULE-041, RULE-042 |
| `virtualization` | PAT-002 | RULE-010, RULE-011, RULE-012, RULE-016, RULE-031, RULE-032, RULE-033, RULE-034, RULE-035, RULE-036 |

## Application patterns

| Pattern | Title | Decisions |
| --- | --- | --- |
| [PAT-001](patterns/PAT-001-application-shell.md) | Application shell | command-scope, navigation-model |
| [PAT-002](patterns/PAT-002-list-page.md) | Searchable and filterable list page | data-surface, data-processing-location, selection-scope, row-activation, data-resilience, virtualization |
| [PAT-003](patterns/PAT-003-record-detail.md) | Record detail page | permission-state |
| [PAT-004](patterns/PAT-004-form-page.md) | Create and edit form page | form-layout, field-annotation, submit-feedback |
| [PAT-005](patterns/PAT-005-contextual-edit.md) | Short contextual edit in a drawer or focused dialog | edit-surface, modal-behavior |
| [PAT-006](patterns/PAT-006-settings-page.md) | Settings page with optional advanced sections | progressive-disclosure, navigation-model |
| [PAT-007](patterns/PAT-007-multi-step-task.md) | Multi-step task with review and preserved state | save-model, submit-feedback |
| [PAT-008](patterns/PAT-008-dashboard.md) | Dashboard whose content reflects actual tasks and data | feedback-channel, data-resilience, permission-state |
