# mausVoice CLI

This crate builds three binaries, one per backend environment.

| Binary             | Firebase project                                  | Default `--site`        |
| ------------------ | ------------------------------------------------- | ----------------------- |
| `mausvoice`          | `mausvoice-prod`                                    | `https://mausvoice.com`   |
| `mausvoice-dev`      | `mausvoice-dev`                                     | `http://localhost:4321` |
| `mausvoice-emulator` | `mausvoice-dev` + Auth emulator on `127.0.0.1:9099` | `http://localhost:4321` |

Each binary writes its credentials to `~/.config/mausvoice/<env>.json` (mode `0600` on Unix). Running one won't overwrite another's session.

## Install

Released builds are published to GitHub Releases and mirrored to Homebrew, APT, and RPM repositories. Pick the channel that matches your OS. Append `--dev` (or `-Dev` on Windows, or swap the package name on package managers) to install the `mausvoice-dev` build that targets the dev Firebase backend.

### macOS / Linux (shell installer)

```sh
curl -fsSL https://mausvoice.com/install.sh | sh
```

Dev build:

```sh
curl -fsSL https://mausvoice.com/install.sh | sh -s -- --dev
```

Pin a specific version:

```sh
curl -fsSL https://mausvoice.com/install.sh | sh -s -- --version 1.2.3
```

Installs to `$MAUSVOICE_INSTALL/bin` (defaults to `~/.mausvoice/bin`) and appends it to your shell profile.

### Windows (PowerShell)

```powershell
iwr https://mausvoice.com/install.ps1 -UseBasicParsing | iex
```

Dev build:

```powershell
& ([scriptblock]::Create((iwr https://mausvoice.com/install.ps1 -UseBasicParsing))) -Dev
```

Pin a specific version:

```powershell
& ([scriptblock]::Create((iwr https://mausvoice.com/install.ps1 -UseBasicParsing))) -Version 1.2.3
```

Installs to `%MAUSVOICE_INSTALL%\bin` (defaults to `%USERPROFILE%\.mausvoice\bin`) and adds it to your user `PATH`.

### Homebrew (macOS, Linux)

```sh
brew tap mausvoice/mausvoice
brew install mausvoice
```

Dev build (side-by-side install is fine — the binaries have different names):

```sh
brew install mausvoice-dev
```

Upgrade:

```sh
brew update && brew upgrade mausvoice
```

### APT (Debian, Ubuntu)

```sh
# Add GPG key
curl -fsSL https://mausvoice.github.io/apt/gpg-key.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/mausvoice.gpg

# Add repository
echo "deb [signed-by=/usr/share/keyrings/mausvoice.gpg] https://mausvoice.github.io/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/mausvoice.list

sudo apt-get update
sudo apt-get install mausvoice
```

For the dev build, swap `stable` for `dev` in the `deb` line and install `mausvoice-dev` instead.

Upgrade with `sudo apt-get update && sudo apt-get upgrade mausvoice`.

### RPM (Fedora, RHEL, openSUSE)

**Fedora / RHEL:**

```sh
sudo tee /etc/yum.repos.d/mausvoice.repo <<'EOF'
[mausvoice-stable]
name=mausVoice (stable)
baseurl=https://mausvoice.github.io/rpm/packages/stable
enabled=1
gpgcheck=1
gpgkey=https://mausvoice.github.io/rpm/gpg-key.asc
EOF

sudo dnf install mausvoice
```

**openSUSE:**

```sh
sudo zypper addrepo --gpgcheck https://mausvoice.github.io/rpm/packages/stable mausvoice-stable
sudo rpm --import https://mausvoice.github.io/rpm/gpg-key.asc
sudo zypper install mausvoice
```

For the dev build, swap the `stable` path for `dev` (`baseurl=https://mausvoice.github.io/rpm/packages/dev`) and install `mausvoice-dev` instead.

### Direct download

Every release also posts tarballs, zips, `.deb`, and `.rpm` artifacts at
<https://github.com/voquill/voquill/releases>. Prod releases are tagged `cli-v<version>`, dev releases are tagged `cli-dev-v<version>` and marked as pre-release.

### Upgrading from the CLI itself

Once installed, you can re-run the install script through the binary:

```sh
mausvoice upgrade
```

This re-executes the appropriate installer for the channel you're on.

## Release channels and publishing

The [`release-cli.yml`](../.github/workflows/release-cli.yml) workflow drives every publish target:

- **Trigger** — every push to `main` that touches `cli/**` cuts a new **dev** release (auto-bumps patch, tagged `cli-dev-v<version>`, marked pre-release). Prod releases are cut via `workflow_dispatch` and promote the most recent (or specified) dev tag to `cli-v<version>`.
- **GitHub Releases** — uploads `mausvoice[-dev]-<target>.tar.gz` / `.zip`, plus `.deb` and `.rpm` packages for Linux.
- **Homebrew tap** — regenerates the formula in [`mausvoice/homebrew-mausvoice`](https://github.com/mausvoice/homebrew-mausvoice).
- **APT repository** — adds the new `.deb` to [`mausvoice/apt`](https://github.com/mausvoice/apt) (`stable` codename for prod, `dev` for dev).
- **RPM repository** — adds the new `.rpm` to [`mausvoice/rpm`](https://github.com/mausvoice/rpm) under `packages/stable` or `packages/dev`.
- **Install scripts** — `install.sh` and `install.ps1` are served from `mausvoice.com` and resolve the latest matching tag on each channel.

## Build

```sh
cargo build             # all three, debug
cargo build --release
```

Binaries end up in `target/debug/` or `target/release/`.

## Running locally

### Prod

```sh
cargo run --bin mausvoice -- login
```

Opens the live authorize page and uses real Firebase.

### Dev

Astro dev server plus the dev Firebase project:

```sh
# terminal 1
cd ../apps/web && pnpm run dev

# terminal 2
cargo run --bin mausvoice-dev -- login
```

Hits `http://localhost:4321/authorize?env=dev&...`, which loads the dev Firebase config.

### Emulators

```sh
# terminal 1
firebase emulators:start --only auth --project mausvoice-dev

# terminal 2
cd ../apps/web && pnpm run dev

# terminal 3
cargo run --bin mausvoice-emulator -- login
```

With `?env=emulator` the authorize page calls `connectAuthEmulator(auth, "http://127.0.0.1:9099")`. The whole sign-in round-trip stays on your machine.

## Pointing at a different frontend

Pass `--site <origin>` to any binary if you want to test against a preview deploy, staging, or some other host. The binary still picks which Firebase project the login goes through.

```sh
mausvoice login --site https://preview-42.mausvoice.com
mausvoice-dev login --site https://staging.mausvoice.com
```

The CLI appends `/authorize` itself, so just give it the origin.

## Agent sessions

Wrap an agent command in a mausVoice session:

```sh
mausvoice agent [claude|codex|codebuff]
```

Each session gets a random name (e.g. `brave-octopus`) — pass `--slug my-name` to set your own (it's kebab-cased for you). The session is written to the Realtime Database under `session/<uid>/<sessionId>`. The wrapped command runs inside a pty, so interactive TUIs like `claude` work. Exiting the wrapped command deletes the session.

You need to `login` first so the CLI has a token to talk to RTDB. `mausvoice-emulator agent` talks to the RTDB emulator on `127.0.0.1:9000` — start it with `firebase emulators:start --only auth,database --project mausvoice-dev`.

## One-time Firebase setup

Do this once for `mausvoice-prod` and once for `mausvoice-dev` in the Firebase Console:

1. Authentication → Sign-in method → enable Google.
2. Authentication → Settings → Authorized domains → add wherever the authorize page is hosted (`mausvoice.com` for prod). `localhost` is allowed by default.
