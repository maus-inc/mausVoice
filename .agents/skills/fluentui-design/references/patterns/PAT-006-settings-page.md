---
id: PAT-006
title: Settings page with optional advanced sections
decisions: [progressive-disclosure, navigation-model]
rules: [RULE-013, RULE-014]
components: [Accordion, AccordionItem, AccordionHeader, AccordionPanel, Switch, RadioGroup, Radio, Select, Dropdown, Option, Button, Field, TabList, Tab]
derived: [application-owned settings model, application-owned persistence adapter]
---

# Settings page with optional advanced sections

## User task

Review and change configuration for a product or a record, where most values are simple and a few
are advanced.

## When to use / when not

Use it when settings fall into a few peer groups with occasional advanced options. Do not hide
required values inside collapsed sections, and do not use this pattern for an ordered setup task,
which is the multi-step pattern.

## Region order

1. Page heading naming the scope of the settings.
2. Either peer tabs or a single scrolling page of sections.
3. Simple settings first.
4. Advanced sections, collapsed by default.
5. Save or apply action.

## Component mapping

Accordion and its parts, Switch, RadioGroup and Radio, Select, Dropdown, Option, TabList, Tab, Button,
and Field are verified exports. The settings model and the persistence adapter are application-owned.
Loading and saving settings are application responsibilities.

## Interaction flow

The user changes a value and either saves explicitly or receives an immediate effect, depending on
the setting. Advanced sections expand on demand. A validation error inside a collapsed section
expands that section and moves focus to the field so the error is never hidden.

## State ownership

The application owns the settings model, which values are dirty, and whether a save is pending. The
accordion owns only which sections are expanded.

## Responsive behavior

Advanced sections behave the same at every width. Where tabs are used, overflow tabs move into a menu
at narrow widths rather than scrolling away.

## Accessibility

Accordion headers expose their expanded state and are operable by keyboard. Dependent values are
grouped so their relationship is announced. No required setting is reachable only through a
collapsed region.

## Edge cases

A settings load failure shows an error with retry rather than rendering empty controls. A save
failure keeps the edited values and reports the problem. A permission-restricted section is shown
with an explanation rather than silently omitted.

## Rules applied

RULE-013, RULE-014

## Derived decisions

Whether a setting applies immediately or on save, and how advanced sections are grouped, are
application decisions. Persistence is an application responsibility. Server-side validation is
mandatory; client-side validation is advisory only.

## Tests

Fixture settings rendering test, collapsed-validation-error test, and a tabs-or-sections keyboard
test.
