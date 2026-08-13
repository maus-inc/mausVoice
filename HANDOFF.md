# mausVoice — Handoff to Adrian

Goal: fix the docs website (logo, favicon, theme, buttons, light mode, factual accuracy),
remove Voquill remnants, and set up a real Homebrew tap that auto-publishes on release.

Everything below is deterministic and self-contained — no reliance on the agent's machine.

---

## 0. Current state of the repository

All work lives on branch **`arena/019ff9e4-mausvoice`** in **`maus-inc/mausVoice`**.
Remote HEAD is `0116c53`.

What is **already pushed** to that branch:

| Area | Files |
| --- | --- |
| Docs logo | `apps/docs/src/assets/logo.png` (now the canonical branding logo) |
| Docs favicon | `apps/docs/public/favicon.png` (new) |
| Docs theme / buttons / light mode | `apps/docs/src/styles/custom.css` |
| Docs factual + Voquill fixes | `apps/docs/src/content/docs/{getting-started/introduction.md, getting-started/macos.md, guides/dictionary.md, guides/post-processing.md, guides/transcription.md}` |
| Docs config | `apps/docs/astro.config.mjs`, `apps/docs/src/content/docs/index.mdx` |
| Deleted wrong assets | `apps/docs/public/favicon.svg`, `apps/docs/src/assets/houston.webp`, `apps/docs/src/assets/icon.svg` |
| Release body fix | `scripts/ci/generate-release-body.mjs` |
| Cask render script (new) | `scripts/ci/render-cask.mjs` |
| Tap (new) | `homebrew-mausvoice/Casks/mausvoice-desktop.rb`, `homebrew-mausvoice/README.md` |
| README download chips | `README.md` |

What is **NOT** pushed (blocked — see Part B):

- `.github/workflows/release.yml` — the `publish-cask` job.

---

## A. Reproduce the docs fixes (if you prefer to redo rather than merge the branch)

If you'd rather apply changes on a fresh branch than merge `arena/019ff9e4-mausvoice`,
the deterministic spec is:

1. **Logo**: copy `branding/mausvoice-logo-256.png` over `apps/docs/src/assets/logo.png`.
2. **Favicon**: copy `marketing/assets/favicon.png` to `apps/docs/public/favicon.png`.
3. **Delete** `apps/docs/public/favicon.svg`, `apps/docs/src/assets/houston.webp`, `apps/docs/src/assets/icon.svg`.
4. **`apps/docs/astro.config.mjs`**: add `favicon: "/favicon.png",` under the Starlight `logo` block.
5. **`apps/docs/src/content/docs/index.mdx`**: remove the `hero.image.file: ../../assets/houston.webp` block.
6. **`apps/docs/src/styles/custom.css`**:
   - Replace all teal accent tokens `hsl(170 …)` (the bluish-green `#87ABA5` = `hsl(170 18% 60%)`) with a monochrome black/white palette (`hsl(0 0% …)`).
   - Delete the `:root, :root[data-theme="light"] { color-scheme: dark; … }` block that force-locked dark mode.
   - Add a proper `:root[data-theme="light"] { … }` block (light background, black text).
   - Delete the `.sl-link-button` / `a[class*="btn"]` overrides that broke hero button variants.
7. **Factual / Voquill fixes** (search-and-replace, exact):
   - `guides/dictionary.md`: replace the `| V quill | mausVoice |` example row with `| Deep Gram | Deepgram |`.
   - `guides/transcription.md`:
     - Default local model is `tiny` (~77 MB), not `base` (~142 MB). Models dir is `transcription-models/`, not `models/`.
     - "API mode" is provider-agnostic (Groq Whisper / Deepgram `nova-3` / OpenAI Whisper), not Groq-only.
   - `guides/post-processing.md`: post-processing modes are **API** / **Off** (independent of transcription mode), not Local/API/Cloud.
   - `getting-started/introduction.md`: "API" row = "Direct connection to your chosen transcription provider."
8. **`getting-started/macos.md`**: Homebrew section becomes `brew tap maus-inc/mausvoice` + `brew install --cask mausvoice-desktop`; **remove** the `mausvoice-desktop-dev` cask (does not exist).

Verify: `pnpm run build` and `pnpm run check-types` inside `apps/docs` (both pass).

---

## B. Blocked item — the release workflow (apply this exact diff)

The agent could not push `.github/workflows/release.yml` because the sandbox
GitHub App lacks the `workflows` permission. Apply this change yourself.

### B.1 Fix the release-body rendering (`scripts/ci/generate-release-body.mjs`)

Already pushed, but for reference the fix is:

```diff
 function badgeImage(src, alt, url) {
   const img = `<img src="${src}" alt="${alt}" height="32" />`;
-  return url ? `[${img}](${url})` : img;
+  return url ? `<a href="${url}">${img}</a>` : img;
 }
```

and the license chip URL:

```diff
-  `  ${logoChip("opensourceinitiative", "AGPL-3.0 license", "LICENCE")}`,
+  `  ${logoChip("opensourceinitiative", "AGPL-3.0 license", `${githubBase}/blob/main/LICENCE`)}`,
```

### B.2 Add `scripts/ci/render-cask.mjs` (new file — already pushed)

```js
#!/usr/bin/env node

// Renders the Homebrew cask from its source-of-truth template in this repo,
// stamping in the release version and the computed SHA-256 of the published
// macOS DMG. Writes the finished cask to stdout.
//
// Reads:
//   VERSION - e.g. 0.1.3
//   SHA256  - hex digest of mausVoice_<version>_universal.dmg

import { readFileSync } from "node:fs";

const version = process.env.VERSION ?? "";
const sha256 = process.env.SHA256 ?? "";

if (!version) {
  console.error("VERSION is required");
  process.exit(1);
}
if (!sha256) {
  console.error("SHA256 is required");
  process.exit(1);
}

const template = new URL(
  "../../homebrew-mausvoice/Casks/mausvoice-desktop.rb",
  import.meta.url,
);

let cask = readFileSync(template, "utf8");
cask = cask.replace(/^  version ".*"$/m, `  version "${version}"`);
cask = cask.replace(/^  sha256 .*$/m, `  sha256 "${sha256}"`);

process.stdout.write(cask);
```

### B.3 Append this job to `.github/workflows/release.yml`

Add the `publish-cask` job after the existing `publish` job (after the
`dist/**/*.AppImage` line of its `files:` block):

```yaml
  publish-cask:
    name: Publish Homebrew cask
    needs: publish
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout source
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262

      - name: Download macOS DMG
        env:
          VERSION: ${{ inputs.version }}
          INPUT_TAG: ${{ inputs.tag }}
          TOKEN: ${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          TAG="${INPUT_TAG:-mausVoice-v${VERSION}}"
          URL="https://github.com/maus-inc/mausVoice/releases/download/${TAG}/mausVoice_${VERSION}_universal.dmg"
          curl -fsSL -H "Authorization: token ${TOKEN}" -o /tmp/mausVoice.dmg "$URL"

      - name: Compute checksum
        id: checksum
        run: |
          echo "sha256=$(shasum -a 256 /tmp/mausVoice.dmg | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"

      - name: Render cask
        env:
          VERSION: ${{ inputs.version }}
          SHA256: ${{ steps.checksum.outputs.sha256 }}
        run: |
          node scripts/ci/render-cask.mjs > /tmp/mausvoice-desktop.rb
          cat /tmp/mausvoice-desktop.rb

      - name: Publish cask to tap
        env:
          VERSION: ${{ inputs.version }}
          TOKEN: ${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          REPO_URL="https://x-access-token:${TOKEN}@github.com/maus-inc/homebrew-mausvoice.git"
          rm -rf /tmp/tap && mkdir -p /tmp/tap && cd /tmp/tap
          git init -b main
          git remote add origin "$REPO_URL"
          # Pull any existing history; tolerate an empty (brand-new) tap repo.
          git fetch --depth 1 origin main 2>/dev/null && git reset --hard FETCH_HEAD || true
          mkdir -p Casks
          cp /tmp/mausvoice-desktop.rb Casks/mausvoice-desktop.rb
          git config user.name "mausVoice release"
          git config user.email "release@maus-inc.local"
          git add Casks/mausvoice-desktop.rb
          git commit -m "mausvoice-desktop ${VERSION}" || echo "Cask unchanged"
          git push origin main
```

---

## C. The tap itself (files — already pushed)

`homebrew-mausvoice/Casks/mausvoice-desktop.rb`:

```ruby
cask "mausvoice-desktop" do
  version "0.1.3"
  sha256 :no_check

  url "https://github.com/maus-inc/mausVoice/releases/download/mausVoice-v#{version}/mausVoice_#{version}_universal.dmg",
      verified: "github.com/maus-inc/mausVoice"
  name "mausVoice"
  desc "Voice typing for your own machine, anywhere you can type"
  homepage "https://maus-inc.github.io/mausVoice/"

  livecheck do
    url "https://github.com/maus-inc/mausVoice/releases.atom"
    regex(%r{releases/tag/mausVoice-v(\d+(?:\.\d+)+)}i)
  end

  depends_on macos: ">= :ventura"

  app "mausVoice.app"

  caveats <<~EOS
    mausVoice is not notarized and requires macOS 13.3 or later. On first launch,
    right-click the app in Applications and choose Open to bypass the Gatekeeper
    "unidentified developer" warning.
  EOS

  zap trash: [
    "~/Library/Application Support/com.mausinc.desktop",
    "~/Library/Saved Application State/com.mausinc.desktop.savedState",
  ]
end
```

---

## D. To-do — items NOT completed in this session

Do these in order.

### D.1 (Required) Commit & push the release workflow

```bash
git clone https://github.com/maus-inc/mausVoice.git && cd mausVoice
git checkout arena/019ff9e4-mausvoice
# apply Part B.3 (append publish-cask job to .github/workflows/release.yml)
git add .github/workflows/release.yml
git commit -m "release: auto-publish Homebrew cask"
git push origin arena/019ff9e4-mausvoice
```

### D.2 (Required) Publish the tap repo (first seed)

The repo `maus-inc/homebrew-mausvoice` exists but is **empty**.

```bash
cd homebrew-mausvoice
git init -b main
git add Casks README.md
git commit -m "Add mausvoice-desktop cask"
git remote add origin https://github.com/maus-inc/homebrew-mausvoice.git
git push -u origin main
```

### D.3 (Required) Grant the release token write access to the tap

`secrets.RELEASE_TOKEN` (the maintainer PAT already used by `release.yml`) must
have **Contents: write** on `maus-inc/homebrew-mausvoice`, otherwise the
`publish-cask` push will 403.

### D.4 (Required) Revoke the leaked tokens

Several PATs were pasted in chat during this work and should be treated as
compromised. Revoke them in GitHub → Settings → Developer settings →
Personal access tokens. (The agent did not store them; they are only in chat history.)

### D.5 (Required) Verify the tap end-to-end

```bash
brew tap maus-inc/mausvoice
brew install --cask mausvoice-desktop
brew audit --cask mausvoice-desktop
```

Note: until the first release runs through the new `publish-cask` job, the cask
ships `sha256 :no_check`. After the first automated publish, the real checksum
is pinned automatically.

### D.6 (Recommended) Fix the Linux docs — factual gap found but not yet fixed

The Linux install docs (`apps/docs/src/content/docs/getting-started/linux.md`)
reference APT and RPM repositories at `mausvoice.github.io`, which **do not
exist** (no such org/repo). Additionally, **no `.rpm` is ever built** (release
assets are `.deb`, `.AppImage`, `.dmg`, `.exe`, `.msi`). Decide:

- **Option 1 (simplest):** remove the APT/RPM repo instructions and point users
  at the `.deb` / `.AppImage` downloads (which are real release assets).
- **Option 2 (infra):** actually build `.rpm` and host real apt/rpm repos — a
  separate, larger project.

### D.7 (Recommended) Open the PR

```bash
gh pr create --base main --head arena/019ff9e4-mausvoice \
  --title "docs: fix logo/theme/factuals; add Homebrew tap + auto-publish"
```

---

## E. Notes / decisions made (why)

- **Tap must be a separate repo.** Homebrew resolves `brew tap maus-inc/mausvoice`
  to `github.com/maus-inc/homebrew-mausvoice` and requires `Casks/` at the repo
  root; tapping the monorepo directly would clone the entire repo per install.
  The source of truth stays in `mausVoice` (`homebrew-mausvoice/`), and CI
  auto-publishes to the tap.
- **`sha256 :no_check`** because every release is currently a pre-release and
  GitHub's `releases/latest` redirect 404s for pre-releases — so no stable
  "latest" URL can be baked in. The cask uses `livecheck` (atom feed, includes
  pre-releases) to auto-resolve the latest version.
- **`-dev` cask removed**: the "dev channel" is just release cadence on `main`,
  not a distinct artifact.
- **Voquill migration code kept**: the intentional rename-migration code in
  `apps/desktop/src-tauri/src/system/paths.rs`, `apps/desktop/src/store/index.ts`,
  `apps/desktop/src-tauri/src/platform/linux/wl/compositor.rs`, and
  `patches/rdev/` is required for upgrade compatibility and was intentionally
  left in place. Only the stale docs example was removed.
