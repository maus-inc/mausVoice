/**
 * The `[plugin, options]` entry `babel-plugin-formatjs` wants, shared by the
 * desktop app and the preview.
 *
 * Both Vite configs mount real desktop components, and those write their copy as
 * `FormattedMessage` literals with no `id`. The plugin derives an id from the
 * text through `formatjsOverrideIdFn`, so the two builds must pass the same
 * function and the same flags or a string resolves to two different ids. The
 * options live here because a copy in each config drifts: the preview once had
 * no such transform at all, and every real component with visible copy threw
 * "An `id` must be provided to format a message" and rendered nothing.
 */
export const formatjsBabelPlugin = (overrideIdFn) => [
  "babel-plugin-formatjs",
  {
    overrideIdFn: (id, defaultMessage, description, filePath) =>
      overrideIdFn(id, defaultMessage, description, filePath) ?? id,
    ast: true,
  },
];
