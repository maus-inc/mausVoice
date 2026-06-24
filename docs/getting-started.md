# Getting Started

Commands in this guide run from the repository root unless a section says
otherwise.

## Repository layout

| Path                     | Description                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`           | Tauri desktop app. React and TypeScript own the UI, state, and business logic; Rust exposes native capabilities. |
| `apps/desktop/src-tauri` | Rust commands for audio, keyboard input, SQLite, Whisper, updates, and other native integrations.                |
| `apps/windows-installer` | Windows installer built with Tauri.                                                                              |
| `apps/docs`              | Astro and Starlight documentation site.                                                                          |
| `enterprise/admin`       | React and Vite enterprise administration dashboard.                                                              |
| `enterprise/gateway`     | Enterprise API gateway.                                                                                          |
| `cli`                    | Rust command-line application.                                                                                   |
| `packages`               | Shared TypeScript and Rust packages used by the applications.                                                    |
| `release`                | Release notes and promotion instructions.                                                                        |
| `docs`                   | Architecture notes and contributor documentation.                                                                |

The pnpm workspace membership is defined in
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml). See
[`desktop-architecture.md`](desktop-architecture.md) for the desktop data flow
and ownership boundaries.

## Prerequisites

### Node.js and pnpm

[`package.json`](../package.json) supports Node.js 18 or newer, but contributors
should install the Node.js version selected by [`.nvmrc`](../.nvmrc), currently
Node.js 24. The repository pins its pnpm version in the `packageManager` field
of [`package.json`](../package.json).

With [nvm](https://github.com/nvm-sh/nvm):

```sh
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
```

Run pnpm from the repository root so it uses the pinned version and the shared
lockfile.

### Native toolchains

- Install Rust with [rustup](https://rustup.rs/) for the desktop app, Windows
  installer, CLI, and Rust packages.
- Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your operating system. Windows contributors can use the
  repository script described in the desktop section below.
## JavaScript and TypeScript workspaces

The root manifest exposes the Turborepo tasks used across pnpm workspaces:

```sh
pnpm run build
pnpm run lint
pnpm run check-types
pnpm run test
```

Turbo runs only scripts exposed by each workspace. Use a pnpm filter when
working on one application or package. The full test task also runs desktop
evals and gateway tests, so it needs the credentials and services described in
those sections.

## Desktop app

On Windows, run the setup script from an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/setup-windows.ps1
```

Pass `-EnableGpu` to the Windows script to install the optional
Vulkan build dependencies.

Start the desktop app with the platform selected automatically:

```sh
pnpm --filter desktop run dev
```

The development command uses the emulator flavor by default. Set
`VITE_FLAVOR=dev` to use the hosted development services. The available
flavors and commands live in
[`apps/desktop/package.json`](../apps/desktop/package.json) and the checked-in
`apps/desktop/.env.*` files.

Validate desktop changes with:

```sh
pnpm --filter desktop run build
pnpm --filter desktop run lint
pnpm --filter desktop run test:unit
```

`pnpm --filter desktop run test` additionally runs integration tests and evals
that require `GROQ_API_KEY`.

## Documentation site

The docs site's commands are defined in
[`apps/docs/package.json`](../apps/docs/package.json):

```sh
pnpm --filter docs run dev
pnpm --filter docs run check-types
pnpm --filter docs run build
```

The development server listens on port 3490.

## Windows installer

Build the installer on Windows after the desktop app has produced its installer
input:

```sh
pnpm --filter @voquill/windows-installer run tauri:build
```

The installer workflow and its other commands live in
[`apps/windows-installer/package.json`](../apps/windows-installer/package.json).

## Enterprise apps

Run and validate the admin dashboard:

```sh
pnpm --filter admin run dev
pnpm --filter admin run lint
pnpm --filter admin run build
```

Run and validate the gateway:

```sh
pnpm --filter @repo/enterprise-gateway run dev
pnpm --filter @repo/enterprise-gateway run check-types
pnpm --filter @repo/enterprise-gateway run test
pnpm --filter @repo/enterprise-gateway run build
```

These commands are owned by
[`enterprise/admin/package.json`](../enterprise/admin/package.json) and
[`enterprise/gateway/package.json`](../enterprise/gateway/package.json). The
gateway tests require PostgreSQL. They use `DATABASE_URL` when set and otherwise
connect to `postgres://postgres:postgres@localhost:5432/voquill`.

## Shared packages

The root build compiles shared packages before their consumers. To work on one
package, filter by the name in its manifest:

```sh
pnpm --filter @voquill/types run build
pnpm --filter @voquill/functions run build
```

Rebuild `@voquill/types` or `@voquill/functions` after changing them so
downstream workspaces see the updated output.

