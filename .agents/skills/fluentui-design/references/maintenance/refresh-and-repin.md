# Refresh and Re-Pin

The bundled rules and patterns are pinned to one reviewed baseline. When the
baseline moves, refresh deliberately instead of editing output by hand.

## When to refresh

- The project installs a `@fluentui/react-components` version other than the
  baseline named in the entry point.
- A rule is disputed in review and needs stronger or newer evidence.
- A new source, such as a design guide or an accessibility standard, is added to
  the reviewed collection.

## The procedure

1. **Refresh the sources.** Add or update the reviewed sources and their
   coverage, then validate the evidence pipeline:

   ```
   npm run validate:sources
   ```

2. **Re-pin the API facts.** Regenerate the verified allowlist from the sibling
   API-fact source:

   ```
   npm run extract-facts
   npm run check:facts
   ```

3. **Regenerate the indexes and the mirror.**

   ```
   npm run generate
   npm run generate:check
   ```

4. **Confirm the package.** Validate the rules, the actionability lint, and the
   references:

   ```
   npm run validate:rules
   npm run lint:rules
   npm run check:refs
   ```

5. **Run the full gate** before publishing the change:

   ```
   npm run verify
   ```

## Rules for the refresh

- Never hand-edit a generated file. The generated marker says so, and the drift
  gate detects any edit. Delete a stale generated file by regenerating, not by
  deleting it by hand.
- Confirm a new export exists before a rule or pattern names it. An unverified
  name is the most common cause of a failing reference gate.
- Update the baseline table in the entry point and the pinned commit together,
  so a reader never sees a mismatch.
- Record why a rule changed; do not silently adjust a rule to match a newer
  library.

## Related references

- [Reference index](../index.md) for the decision routes.
- [Rule index](../rules/index.md) for the rules grouped by area.
