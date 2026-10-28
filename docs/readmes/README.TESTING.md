# RedAmon testing guide

This document has two audiences: the human maintainer, and **the next Claude Code
session, which reads it before writing or running a test**. It is therefore an
applied rulebook, not just reference. If you are about to add or run a test, read
the [authoring rules](#test-authoring-rules-hard-rules) first.

---

## TL;DR

```bash
./redamon.sh test              # unit gate across every section (the canonical gate)
./redamon.sh test unit         # same
./redamon.sh test integration  # integration tier (heavier deps / cross-layer)
./redamon.sh test all          # unit + integration
./redamon.sh test live         # live tier (self-skips when the stack is down)
./redamon.sh test coverage     # all tiers + per-section coverage + floor

./agentic/run_tests.sh         # just the agent image, unit gate (fast path)
./agentic/run_tests.sh coverage
./agentic/run_tests.sh tests/test_foo.py::TestBar::test_baz   # one node id
```

The **unit tier must be 100% green** — that is the gate (the modern replacement for
the old hand-maintained 31-module `focused` list; `focused` still works as an
alias for `unit`).

---

## How it is built

- Runner: **pytest**, which runs the existing `unittest.TestCase` tests unchanged.
  This was a runner swap, not a test rewrite.
- Tests run **inside each section's Docker image** (where `pydantic`, `langgraph`,
  `tree-sitter`, ripgrep, etc. live). The whole repo is mounted at `/repo` so
  cross-layer tests and `git HEAD` resolve.
- Config lives at each in-container test root: a small `pytest.ini` +
  `conftest.py` at `agentic/`, `recon/`, `recon_orchestrator/`,
  `scanners/ai_attack_surface_scan/`, `scanners/capture_proxy/`, `services/docker_broker/`, and the repo root.
  Keep the `conftest.py` copies in sync — they are intentionally near-identical.
- Test deps are `requirements-test.txt` (`pytest`, `pytest-cov`, `pytest-xdist`,
  `pytest-asyncio`). They are **baked** into the daily-driver images
  (`agentic/requirements.txt`, `recon/requirements.txt`) and **runtime-installed**
  into the occasional-run slim images by the runner.

### Section / image map

| Section | Image | Test root(s) |
|---|---|---|
| agent | `redamon-agent` | `agentic/tests` |
| root group | `redamon-agent` | `tests/`, `supply_chain_*`, `graph_db`, `knowledge_base`, `mcp` |
| recon | `redamon-recon` | `recon/tests` |
| recon_orchestrator | `redamon-recon-orchestrator` | `recon_orchestrator/` + `recon_orchestrator/tests` |
| ai_attack_surface | `redamon-ai-attack-surface` | `scanners/ai_attack_surface_scan/tests` + `adapters/*/tests` |
| capture_proxy | `redamon-capture-proxy` | `scanners/capture_proxy/tests` |
| docker_broker | `redamon-docker-broker` | `services/docker_broker/` |
| shell | (host bash) | `tests/*_test.sh` |
| webapp | `reamon-webapp-test` (`webapp/Dockerfile.test`) | `webapp/src/**/*.test.ts(x)` via vitest |

A missing or unbuildable section image fails the unit gate. The webapp test image
is built from the repository root with the dedicated test Dockerfile and then runs Vitest in that image;
host Node and host `node_modules` are not part of the canonical gate.

### The `shell` section

Parts of RedAmon are bash, not Python: the proportional memory allocator, the
preflight RAM/disk gates, secret and admin handling, and the `tooling/deploy`
driver. Those are covered by `tests/*_test.sh`, which run **on the host** (they
`source redamon.sh` — the `BASH_SOURCE` guard at the bottom of the script stops
the command dispatch from firing) and need no image.

They run in the same tiers as webapp (`unit`, `all`, `coverage`), so the
canonical `./redamon.sh test` gate covers them. Every suite matched by the glob
must be **hermetic or self-skipping**: one that needs a live stack (e.g.
`scan_timeline_db_test.sh` without postgres) prints a `SKIP` line and exits 0.
Smoke/live shell suites are named `*_smoke.sh` / `*_live.sh` and are deliberately
not matched.

### Two oracles, and only one of them runs in CI

Some unit-tier files mix hermetic checks with checks that need a live Neo4j and
self-skip without one. The graph-schema suites are the example, and the split is
deliberate rather than accidental:

| Check | Needs a database | Runs in the gate |
|---|---|---|
| every relationship/property the CODE writes is documented (`test_graph_writes_documented.py`) | no | **yes** |
| every relationship/property in a LIVE graph is documented (`test_schema_catalog.py`) | yes | no, skips |

Both are needed because neither sees everything. The code scan misses the 22
labels written with `SET n += $props`, where the property names are assembled in
Python and appear in no file. The live graph misses every feature this
particular deployment never ran.

So a green gate does NOT mean the live-graph checks passed - it usually means
they skipped. Run them against a stack before trusting a schema change:

```bash
NEO4J_PASSWORD="$(grep '^NEO4J_PASSWORD=' .env | cut -d= -f2-)" \
docker run --rm --network host --entrypoint python3 \
  -e NEO4J_URI=bolt://localhost:7687 -e NEO4J_USER=neo4j -e NEO4J_PASSWORD="$NEO4J_PASSWORD" \
  -v "$PWD:/work:ro" -w /work redamon-recon:latest recon/tests/test_schema_catalog.py
```

Mute Rules (node filters in the code) have the same split. The unit tier pins
the rule decisions against a fake graph and a mocked Prisma; three checks need
real services and skip in the gate. Run them after touching the engine
(`graph_db/node_filters/`, `node_filter_mixin.py`) or `webapp/src/lib/nodeFilterRun.ts`:

| Check | Needs | How to run |
|---|---|---|
| the sweep's real Cypher: keyset paging, the guard re-check in the mute write, tenant scoping, `updated_at` never touched (`tests/test_node_filters_graph_live.py`) | Neo4j | the command in the file's docstring (agent image, on `redamon-network`) |
| one live apply per project, decided by Postgres's serializable transaction (`webapp/src/lib/nodeFilterRun.integration.test.ts`) | Postgres | set `DATABASE_URL`; the command is in the file's header |
| what a real recon scan's end-of-run sweep mutes, graded by an independent oracle | the stack + the lab | [`verify_node_filters_scan.py`](../../testing/guinea_pigs/node_filters_lab/verify_node_filters_scan.py) (usage in its docstring) |

A failing file is reported with the command to re-run it on its own:

```
  FAIL  redamon_governor_test.sh (exit 1) — re-run: bash tests/redamon_governor_test.sh
```

---

## Tiers and auto-tiering

Three markers: `unit`, `integration`, `live`. Rather than editing hundreds of
files, each `conftest.py` auto-marks by **filename**:

- `*_integration.py`, `*_skill.py`, `*_e2e*` -> **integration**
- `live_*`, `*_live*`, `*_smoke*`, `smoke_*` -> **live** (self-skip when a stack is down)
- everything else -> **unit**

Override with an explicit `@pytest.mark.{unit,integration,live}`, on the file or
on a single test inside it.

The gate engine (`tooling/scripts/pytest_isolated.py`) infers the same tiers from the
filename to pick which FILES to run, so the two must stay consistent - and it also
passes the tier to pytest as `-m`, so a single test that has opted out of the tier
its filename implies is honoured. Without that `-m`, filename selection alone
cannot see inside a file: a wall-clock test marked `integration` still ran in the
unit gate and failed whenever the parallel run loaded the host.

---

## Determinism: why each test file runs in its own process

A large body of these tests was written for the old per-file
`python -m unittest tests.test_x` runner, where **every file was its own process**.
Many of them, at import time:

- stub `langchain`/`langgraph` into `sys.modules` (`if X not in sys.modules: ...`), and
- **bake real tool objects against a fake `@tool` decorator** during import.

In a single shared pytest process this is order-dependent: whichever file is
collected first decides for all of them, so e.g. the Shodan tool silently becomes
a `MagicMock` and its tests fail with *"a coroutine was expected, got
`<MagicMock>`"*. This is exactly the class of phantom failure that sends an AI
author "fixing" code that was never broken.

The fix is structural: the gate runs **each test FILE in its own pytest
subprocess**, parallelized, via `tooling/scripts/pytest_isolated.py`. That reproduces the
isolation the tests were designed for and makes the gate deterministic.

Consequences you must know:

- `./redamon.sh test` / `./agentic/run_tests.sh` are deterministic. Prefer them.
- Running `pytest -m unit` over the **whole tree in one process** is *not* the gate
  and may show phantom failures from legacy import-time stubbing. Each
  `conftest.py` adds a `pytest_ignore_collect` that makes a single-process
  `-m unit` run at least skip importing the heavier integration/live files, but
  per-file isolation is still the source of truth.
- A single file, or a single node id, is already isolated — use that while iterating.

Two determinism helpers also live in every `conftest.py`:

- an autouse `_ensure_event_loop` fixture (restores a usable event loop after a
  `unittest.IsolatedAsyncioTestCase` sets it to `None`), and
- the auto-tiering + `-m unit` path-scoping hooks above.

---

## The surgical loop (iterate cheaply)

Each containerized full run costs latency + context. When a test is red, do NOT
re-run the whole suite. Read the precise failure and re-run just that test:

```bash
# one node id, single process (isolated), short traceback:
./agentic/run_tests.sh tests/test_execute_nodes.py::TestCheckRoeBlocked::test_forbidden_tool_blocked

# stop at first failure while iterating, re-run only last failures:
./agentic/run_tests.sh tests/test_foo.py -x
./agentic/run_tests.sh tests/test_foo.py --lf
```

`addopts` in each `pytest.ini` already sets `-ra --tb=short --strict-markers -p
no:cacheprovider` for concise, deterministic output.

---

## Coverage

`./redamon.sh test coverage` (or `./agentic/run_tests.sh coverage`) runs the
unit+integration tiers with `pytest-cov` and prints per-section totals.
`COVERAGE_FILE=/tmp/redamon.coverage` keeps root-owned `.coverage` files out of
the bind mount.

Coverage runs **serially with `--cov-append`** (parallel appends can corrupt the
data file). The floor is enforced with `--cov-fail-under`; set it per section via
`REDAMON_COV_FLOOR` (or the section spec in `redamon.sh`).

To **ratchet** a floor: run coverage, read the section total, set the floor to
`floor(total) - 2`. Measured agentic total (unit+integration) is **81%** — once
the import-time pollution was fixed, real coverage was far above the depressed
41% the old polluted `discover` run reported — so the agentic floor is **79**
(`REDAMON_COV_FLOOR`, default in `agentic/run_tests.sh`). supply_chain baseline
to beat is 72%.

> **The floor guards against rot, not quality.** Because an AI writes these tests,
> the number is gameable by hollow tests that execute code and assert nothing. The
> real quality gate — mutation testing on security-critical modules — is future
> work. The interim defense is the authoring rules below.

---

## Test-authoring rules (hard rules)

1. **Assert on behavior and output, not mere execution.** A test that runs code
   but checks nothing is worse than no test — it inflates coverage and asserts
   nothing.
2. **Name each test as the guarantee it enforces**
   (`test_edit_rejects_non_unique_target`), never `test_edit_2`. The name is the
   spec a human reviews.
3. **Do not assert "current behavior" you have not confirmed is correct.** Tests
   must not enshrine bugs. If a test reveals a real bug, mark it
   `@pytest.mark.xfail(strict=True, reason=...)` and surface it — do not rewrite
   it to pass.
4. **Never mock the unit under test.** Keep an `integration` test that exercises
   the real dependency so the mocks cannot drift from reality.
5. **Never mutate global state (`sys.modules`, `os.environ`, cwd) at import time.**
   Use fixtures or `mock.patch.dict(sys.modules, {...})` / `mock.patch.dict(
   os.environ, {...})` scoped to a single test. If you must shim at import time
   (e.g. to import a module on bare Python), **capture the originals and restore
   them in `tearDownModule()`** — see `agentic/tests/test_t14_prompt_injection_previews.py`
   for the reference pattern. Leaving a stub in place drops later-imported victims
   to 0% coverage and breaks their collection.

### Environmental prerequisites (bucket 2)

A test that needs a live stack, a network service, a tool binary, or git HEAD
must **self-skip cleanly** (`skipUnless`/`skipIf` / `raise unittest.SkipTest`),
never hard-fail. If it currently hard-fails on a missing prerequisite, that
missing skip-guard *is* the bug.

---

## Adding a test to a tier

- **unit**: name it `test_*.py` with no special suffix. It must be hermetic (no
  network, no running stack) and pass in its own process.
- **integration**: name it `*_integration.py` / `*_skill.py`, or add
  `@pytest.mark.integration`. It may reach across layers / use heavier deps.
- **live**: name it `live_*` / `*_live*` / `*_smoke*`, or add `@pytest.mark.live`,
  and make it self-skip when the stack/service is absent.

---

## Future work / next steps

- **CI**: run the unit gate on every PR and the full `all` tier nightly.
- **Mutation testing** on the security-critical modules (supply-chain, auth /
  access control) as the *real* quality gate — coverage alone is not one.
- **HTTP record/replay** (`respx` / VCR) so the `live` tier shrinks.
- **Playwright e2e** wired into the gate (see `testing/e2e/`).
