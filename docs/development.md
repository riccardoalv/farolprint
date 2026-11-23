# Development

How to work on FarolPrint: setup, commands, tests, CI, commits and releases. The conventions are in
[CONTRIBUTING.md](../CONTRIBUTING.md) and [CLAUDE.md](../CLAUDE.md).

## Requirements

- [Bun](https://bun.sh), the version in `package.json` → `packageManager`
- git
- Docker, only to build the image
- An Anycubic Kobra printer in LAN mode, only to test against real hardware

`bun install` also installs the husky git hooks (`prepare` script).

## Commands

| Command | What it does |
|---|---|
| `bun run dev:web` | API on `:7100` + web UI with hot reload |
| `bun run dev` | Same, through Turborepo's default output |
| `bun run build` | Build every package and app |
| `bun run lint` | Biome check |
| `bun run format` | Biome formatter |
| `bun run check-types` | TypeScript in every package (also generates routes and i18n) |
| `bun run test` | `bun test` in every package |
| `bun run db:migrate` | New Prisma migration (`prisma migrate dev`) |
| `bun run --filter @farolprint/api fake-printer` | A fake Kobra 4 on `127.0.0.1` ([Fake printer](#fake-printer)) |

Scripts of one workspace run with `bun run --filter <package> <script>`, for example
`bun run --filter @farolprint/web build`.

## Running it

`bun run dev:web` starts the API and the web UI. Open the URL Vite prints, create the first account and add a printer
by IP. Data goes to `FAROLPRINT_DATA_DIR` (default `data/`).

A printer accepts **a single MQTT session**: stop any other FarolPrint connected to it (another server or Docker
container) before connecting a development build to the same printer. Without a printer, use the
[fake printer](#fake-printer).

## Fake printer

`bun run --filter @farolprint/api fake-printer` runs `apps/api/dev/fake-printer.ts`, a fake Kobra 4 with an ACE in the
middle of a print. It listens on `127.0.0.1` only and never talks to a real printer: add a printer with the IP
`127.0.0.1` in the dashboard. It is a development tool, not shipped in the Docker image (which copies `apps/api/src`
only).

What it answers, following [protocol.md](protocol.md):

- **HTTP on 18910**: `/info`, `/ctrl` (checks the signature and returns the MQTT credentials encrypted like the
  printer) and `/gcode_upload` (the file joins the printer's list).
- **MQTT over TLS on 9883**, with the bundled Slicer certificate, read only: one session at a time, username and
  password checked. Every request is acknowledged on `…/response` with its `msgid`, and reports carry a `msgid` of
  their own, like the Kobra 4, so `request()` in the client resolves with the acknowledgement.
- Every command in [What FarolPrint sends](protocol.md#what-farolprint-sends): `info`, `print/query` (answered only
  while printing), `print/start` (preheating, then the calibrations it asks for), pause (10401), resume, stop (10601,
  then an `updated` report with the targets at 0), `print/update` (an `updated` report), the light query (two `control`
  messages), peripherals, the ACE, `/` and `/test_model` file lists, file details, object skip, fan, axes, camera and
  rename. `tempature/set` and axis moves are refused during a print with 10301, as the Kobra 4 does.
- Temperatures and progress are pushed as they change, about once a second.
- **Camera on 18088** (`/live/<token>`): an ffmpeg test pattern. Without ffmpeg the stream answers 503 and everything
  else keeps working.

| Variable | Default | Role |
|---|---|---|
| `FAROLPRINT_FAKE_HTTP_PORT` | `18910` | HTTP port |
| `FAROLPRINT_FAKE_MQTT_PORT` | `9883` | MQTT port |
| `FAROLPRINT_FAKE_CAMERA_PORT` | `18088` | Camera port |
| `FAROLPRINT_FAKE_ACE_UNITS` | `1` | ACE units, `0` for an external spool only, up to `4` |
| `FAROLPRINT_FAKE_PRINT_SEC` | `5400` | Length of a print in seconds |
| `FAROLPRINT_FFMPEG` | as for the API | ffmpeg for the camera |

FarolPrint always reaches a printer on 18910 and 9883, so the dashboard can only add the fake on those two ports; other
ports (`0` picks a free one) are for tests. The values it has to invent are plainly fake (`fake-user`,
`fake-kobra4-device`, firmware `0.0.0-fake`, `Fake_Test_*.gcode`). Where the real printer's answer is not known, such as
the refusal of a wrong `/ctrl` signature, a wrong upload token, a second MQTT session or a missing file, the fake picks
one: protocol.md stays the reference, not the fake.

`apps/api/test/fake-printer.test.ts` drives it with FarolPrint's own `fetchPrinterCredentials`, `KobraMqttClient`,
`uploadGcode` and `PrinterBridge`, and fails when the client gains a command the fake does not answer: a new command
needs its answer in the fake.

## Tests

Every change ships with tests that run in CI. This is a rule of the project, not a goal: a feature, a fix or a
refactor without tests for every case it introduces is not finished, whatever the layer. What "every case" means:

- **Shared schemas**: defaults, accepted and rejected inputs, every helper function.
- **API services**: every public method, with the success path, the error path and the edge cases (offline printer,
  printer busy, empty data, broken stored payloads). Prisma, the bridge and the network are replaced by small fakes.
- **API controllers**: every route, through a Nest testing module or by calling the controller with fakes.
- **Bridge**: every state transition and every event emitted, fed with anonymized MQTT payloads.
- **Migrations**: applied to a fresh SQLite database, checking the tables and columns they add.
- **i18n**: every locale has every key with the same placeholders as the base locale.
- **Web components**: every visible state (loading, empty, data, error, disabled) and every user action, with the API
  mocked. Route pages are tested through their components.

Tests are written in the same change as the code, never in a follow-up.

| Suite | Where | Run |
|---|---|---|
| Shared schemas | `packages/shared/test` | `cd packages/shared && bun test` |
| Protocol | `packages/kobra-protocol/test` | `cd packages/kobra-protocol && bun test` |
| Locale parity | `packages/i18n/test` | `cd packages/i18n && bun test` |
| API and bridge | `apps/api/test` | `cd apps/api && bun test` |
| Web UI | `apps/web/src/**/*.test.{ts,tsx}` (Vitest + Testing Library, happy-dom) | `cd apps/web && bun run test` |

- API service tests run against a real SQLite database: `test/helpers/db.ts` creates a temporary file, applies every
  migration with the same migrator as production and seeds printers, files and jobs. `apps/api/bunfig.toml` preloads
  `test/helpers/preload.ts`, which points `FAROLPRINT_DATA_DIR` at a temporary directory. Controllers are tested by
  calling them with fake services; `installI18n()` must be called in tests that check translated texts.
- Bridge tests build a `PrinterBridge` and feed it MQTT payloads (`info/report`, `print/report`,
  `multiColorBox/report`) shaped like the ones a real printer sends; the network, the database and Spoolman are replaced
  by small fakes. See `apps/api/test/spool-usage.test.ts`.
- Payloads in tests come from real printers and are **anonymized**: no MQTT credentials, device IDs, tokens, serial
  numbers or public IPs.
- Web tests render components with Testing Library in happy-dom; the locale is set to English in `src/test/setup.ts`.
  `renderWithProviders(ui, { queryClient, path })` (`src/test/render.tsx`) wraps a component in a router and a query
  client: pass a client prefilled with `setQueryData` for pages that read the cache (settings, session role), and a
  `path` to check which link is active. Stores that read `localStorage` at import are tested by resetting the module
  (`vi.resetModules()`) and importing them again.

## Theme

Light and dark themes follow the device, and the user can force one from Settings → General or the account menu
(`src/stores/theme.ts`, kept per browser). An inline script in `index.html` applies the theme before React starts so
the page never flashes the wrong colours. Components use only the colour tokens in `src/styles.css` (`bg-card`,
`text-muted-foreground`, `bg-primary`…), never fixed palette colours, so both themes stay readable; when a fixed colour
is unavoidable, give it a `dark:` variant. The primary colour is a pastel: use `bg-primary` with
`text-primary-foreground` for filled elements, and `text-primary-strong` (never `text-primary`) for text and icons in the
brand colour, which is a deeper shade in the light theme.

## Style and hooks

| Language | Formatter | Linter |
|---|---|---|
| TypeScript / React / JSON | Biome | Biome |

Husky hooks:

| Hook | Runs |
|---|---|
| `pre-commit` | `biome check --write` on staged files |
| `commit-msg` | `scripts/check-commit-msg.sh` (Conventional Commits) |
| `pre-push` | `bun run lint` and `bun run check-types` |

## CI

GitHub Actions run on every push to `main` and on every pull request:

| Workflow | Checks |
|---|---|
| `ci.yml` | lint, type-check, tests with a coverage summary, web build, Docker image build |
| `commits.yml` | every commit message and the PR title follow Conventional Commits |
| `docker-image.yml` | on `main`: builds and pushes `ghcr.io/riccardoalv/farolprint:latest` and `sha-<commit>` |
| `release-please.yml` | keeps the release PR up to date; on release, pushes the versioned image |

## Commits and releases

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org). PRs are squash-merged, so
the PR title becomes the commit on `main`. Types and scopes are listed in [CONTRIBUTING.md](../CONTRIBUTING.md).

Releases are made by [release-please](https://github.com/googleapis/release-please):

1. Every push to `main` updates a release PR with the next version and the changelog, from the commits since the last
   release (`feat` → minor, `fix` → patch; before 1.0.0, a breaking change bumps the minor).
2. The release PR bumps the version of every `package.json` and updates `CHANGELOG.md`.
3. Merging it tags the release (`vX.Y.Z`) and creates the GitHub release.
4. The same workflow builds the Docker image for amd64 and arm64 and pushes it to `ghcr.io/riccardoalv/farolprint`
   with the tags `X.Y.Z`, `X.Y` and `latest`.
