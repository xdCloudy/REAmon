# REAmon product boundary

REAmon is a reverse-engineering workspace built from an earlier codebase. The
earlier security-scanning product is not part of the REAmon runtime or user
experience. This document records the intentional boundary so future changes do
not accidentally reintroduce pentesting workflows or upstream update behavior.

## Shipped REAmon surface

The supported product consists of:

- authenticated users and project ownership;
- reverse-engineering workspaces;
- browser-selected file and folder imports with bounded storage;
- artifact inventory, profiling, and derived analysis targets;
- capability matching and operator-approved analysis tasks;
- bounded providers, findings, hypotheses, evidence, activity, and graph replay;
- PostgreSQL, Neo4j, the analysis agent, the webapp, and the REAmon worker.

The visible application has only workspace navigation, user administration,
LLM provider configuration, system information, and REAmon documentation links.
Project settings are workspace routes; they do not expose the inherited target,
recon, scanner, exploit, traffic-capture, or vulnerability configuration forms.

## Explicitly retired

The following inherited surfaces are not supported and must not be enabled by a
normal install or restart:

- GVM/OpenVAS, Kali, recon, Nmap/Nuclei/Metasploit, CVE, exploit, and scanner
  workflows;
- TrafficMind, capture proxy, traffic ingest, and attack-surface routes;
- the old graph, reports, insights, CypherFix, and pentest navigation pages;
- scanner/tool image builds, OSV and supply-chain feed refreshes, and scanner
  database bootstrap;
- MCP/pentest provider and external-agent token settings;
- the inherited RedAmon version endpoint, update notification, changelog, and
  update command.

Retired top-level pages redirect to the workspace list. Retired installer flags
and scanner synchronization commands fail closed with an explanatory error.
Stale `.gvm-enabled` and knowledge-base markers are ignored. The default Compose
runtime starts only the REAmon core services.

## Lifecycle contract

Use the REAmon entrypoint:

```bash
./reamon.sh install
./reamon.sh up
./reamon.sh status
./reamon.sh down
```

`./reamon.sh update` is intentionally disabled. REAmon never checks, fetches, or
pulls an upstream project. Reviewed releases are installed by the deployment
operator from the REAmon repository and then rebuilt through the normal release
process. The application displays its packaged version and does not make a
runtime version request.

The historical `redamon.sh` filename remains only as an internal lifecycle
implementation detail for existing self-hosted installs. It is not an upstream
remote, update source, or supported product identity.

## Data and compatibility

The existing PostgreSQL and Neo4j stores are retained so a deployment can be
upgraded without deleting operator data. Existing database fields and internal
service names may remain for storage compatibility, but they are not exposed as
REAmon features. New workspaces use `REVERSE_ENGINEERING` records and the
REAmon workspace APIs; no new legacy security projects are created.

Original third-party licenses and required notices remain in the repository.
They do not imply that the retired tools are part of the REAmon product.
