---
id: PAT-004
title: Create and edit form page
decisions: [form-layout, field-annotation, submit-feedback]
rules: [RULE-005, RULE-006, RULE-007, RULE-029, RULE-030, RULE-037, RULE-038, RULE-039, RULE-040, RULE-041, RULE-042]
components: [Field, Input, Textarea, Select, Combobox, Dropdown, Option, Checkbox, Radio, RadioGroup, Switch, Slider, SpinButton, Label, Button, MessageBar, MessageBarBody, Spinner]
derived: [application-owned FormSection grouping, application-owned validation schema]
---

# Create and edit form page

## User task

Enter or change a set of related values, understand any problems with them, and submit the result
with confidence.

## When to use / when not

Use it when the task is to create or edit a defined object with several fields. Do not use a full
page for editing one or two fields in the context of a list; use the contextual-edit pattern.

## Region order

1. Page heading naming the object, with one primary submit action.
2. Grouped field sections, each introduced by a heading.
3. Submission feedback near the action.
4. Cancel, kept visually secondary.

## Component mapping

Field, Input, Textarea, Select, Combobox, Dropdown, Option, Checkbox, Radio, RadioGroup, Switch,
Slider, SpinButton, Label, Button, MessageBar, and Spinner are verified exports. Each value's domain
chooses its control: free text uses Input or Textarea, a small exclusive set uses RadioGroup, a short
fixed list uses a native Select, a long or searchable list uses Combobox or Dropdown, a submitted
boolean uses Checkbox, an immediate on/off uses Switch, and a bounded quantity uses SpinButton. A
complex option also carries a plain-text value. A bounded numeric field sets its minimum and
maximum, a step that divides the range, a page step that is a multiple of the step, and a formatted
display value that parses back to the stored number. The FormSection grouping and the validation
schema are application-owned. Validation, persistence, and authorization are application
responsibilities.

## Interaction flow

The user moves through fields in one reading order. A field reports its error after blur or on
submit, never before it has been touched. On submit the action becomes disabled and shows a pending
state. Success navigates to the saved record; failure keeps the entered values and shows an error
summary near the action plus field-level messages.

## State ownership

The application owns the draft value, touched and dirty state, the validation result, and the
submission status. Field components render the value and message they are given.

## Responsive behavior

The form is single-column by default and survives narrow widths without changing reading order.
Short related pairs may share a row above the project's narrow breakpoint only.

## Accessibility

Every control has a programmatic label and, where needed, help text tied to the control. A complex
option exposes its plain text as the accessible name, and an option popup follows its trigger in DOM
order so screen-reader navigation reaches the list. A Switch applies immediately while a Checkbox is
submitted with the form, and a parent Checkbox shows the indeterminate state for a partially
selected group. The error summary is announced on submit, and focus moves to the summary or the
first invalid field. The pending submit action keeps an accessible name.

## Edge cases

Server-side validation errors map onto their fields and are also summarized. A numeric value with no
meaningful step, such as a phone number, stays a plain Input rather than a SpinButton. A duplicate
submission is prevented while a request is pending. Leaving the page with unsaved changes triggers a
confirmation. A field whose value arrives after load shows a pending state rather than an empty
value.

## Rules applied

RULE-005, RULE-006, RULE-007, RULE-029, RULE-030, RULE-037, RULE-038, RULE-039, RULE-040, RULE-041, RULE-042

## Derived decisions

The FormSection grouping, the single-column default, and the blur-first validation timing are
application decisions. Server-side validation is mandatory; client-side validation is advisory only.

## Tests

Fixture form rendering test, no-early-error test, duplicate-submit test, server-error mapping test,
and an unsaved-change guard test.
