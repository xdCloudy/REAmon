# Browser end-to-end tests

Drives the real RedAmon web app in Chromium against the running stack.

```bash
cd testing/e2e
npm install
npx playwright install chromium
npx playwright test                 # everything
npx playwright test filtersSynthetic
```

## Why this lives outside `webapp/`

`webapp/node_modules` is created by the Docker build and is owned by root, so
`npm install` there fails for the desktop user. This directory has its own
`package.json` and depends on nothing from the app - it only speaks HTTP.

## Prerequisites

The stack must already be serving `http://localhost:3000`
(`docker compose up -d webapp`). The suite deliberately does NOT start the app:
it is meant to exercise the built image, so **rebuild after changing
`webapp/src`** (`docker compose build webapp && docker compose up -d webapp`)
or the tests will run against the previous bundle.

Override the target with `REDAMON_BASE_URL`, and the fixtures with
`REDAMON_PROJECT` / `REDAMON_USER`.

## Auth

`tests/auth.ts` signs the app's own session JWT with `AUTH_SECRET` from the
repo `.env` and sets it as the `redamon-auth` cookie. No password is stored
here, and the tests do not depend on the login page's markup.

The onboarding gate and the GitHub star banner are full-screen overlays keyed
off localStorage; every spec pre-accepts them in `beforeEach` or nothing else
is reachable.

## The suites

- `filters.spec.ts` - the honest pass over every filterable page using whatever
  the project actually contains. Sheets with no rows assert that the Filters
  button is correctly disabled and then skip, and the run prints a coverage
  table so an empty project cannot look like an all-pass.
- `goSafeRenamesBrowser.spec.ts` - an isolated Go project rename journey that
  checks unit selection, whole-project scope opt-in, real API inventory and
  proposal display, apply through the real Go helper, and persisted drafts for
  both files after reload. Only the LLM suggestion endpoint is deterministic;
  project records and rename routes use a disposable PostgreSQL database.
- `filtersSynthetic.spec.ts` - the same journey with the analytics API stubbed,
  so all 19 pages are really rendered, filtered, reloaded and re-checked
  regardless of project data.

Run the Go rename UI test against a fresh app build and disposable PostgreSQL
database with:

```powershell
.\testing\e2e\run-go-safe-renames-isolated.ps1
```

The runner builds the current webapp and agent source, creates uniquely named
temporary containers, a network, and a disposable derived-data volume, seeds
an external Go module into a hash-verified offline module cache, then runs the
Chromium test on a free local port. It removes those containers, network,
volume, and images afterward. It does not use the configured project database.
