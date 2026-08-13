# mausVoice documentation

This Astro Starlight site is the canonical user and developer documentation for mausVoice.

- Published site: <https://maus-inc.github.io/mausVoice/docs/>
- Content: `src/content/docs/`
- Sidebar and site metadata: `astro.config.mjs`
- Theme: `src/styles/custom.css`
- Static assets and machine-readable index: `public/`

## Work locally

From the repository root, install the pinned workspace dependencies and start the docs server:

```bash
pnpm install
pnpm --filter docs dev
```

The development server uses port 3490. Before opening a pull request, run both checks used by CI:

```bash
pnpm --filter docs check-types
pnpm --filter docs build
```

Write product claims against the current source, not assumptions from an older release. Keep mode-specific privacy statements explicit: local transcription, network API transcription, and optional post-processing have different data flows. Use relative links between documentation pages so the deployed `/mausVoice/docs/` base remains intact.

Issues and corrections belong in the [GitHub issue tracker](https://github.com/maus-inc/mausVoice/issues). Security-sensitive reports should follow the private contact guidance in the documentation or code of conduct rather than a public issue.
