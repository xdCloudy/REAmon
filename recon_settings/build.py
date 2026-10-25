"""
Build `registry.json` from `registry.yaml`, joining Prisma for type and default.

Run it after editing the YAML:

    python3 recon_settings/build.py           # write both artifacts
    python3 recon_settings/build.py --check   # fail if either is stale

`--check` is what the drift tests run, so a hand edit to a generated file, or a
YAML edit that was never built, fails the gate rather than reaching a scan.

Two artifacts, one source. A scan container mounts `recon/` but never `webapp/`,
and the webapp build tree cannot import across its own root, so the same bytes
are written to both places and the drift test compares them to each other.

Determinism is a requirement, not a nicety: no timestamps, no version strings,
sorted keys throughout. A generated diff that changes on every run is one people
learn to ignore, which is the failure mode `apiReference.ts` already documents.

The validator is deliberately hand-written rather than `jsonschema`: this module
is imported inside the recon image and the agent image, and a registry that
fails to load is a scan that must not start. A dependency that might not be
installed there would turn the fail-closed rule into a fail-at-runtime one.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
YAML_PATH = HERE / "registry.yaml"
SCHEMA_PATH = HERE / "registry.schema.json"
JSON_PATH = HERE / "registry.json"
WEBAPP_JSON_PATH = REPO_ROOT / "webapp" / "src" / "lib" / "reconSettings" / "registry.json"
ROE_PROMPT_PATH = HERE / "roe_parse_prompt.py"

sys.path.insert(0, str(REPO_ROOT / "tooling" / "scripts"))


class RegistryError(Exception):
    """A registry that does not build. Always fatal: never fall back."""


# --- a small JSON Schema subset ----------------------------------------------------

def _type_ok(value, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    raise RegistryError(f"unsupported schema type {expected!r}")


def _resolve(schema: dict, root: dict) -> dict:
    ref = schema.get("$ref")
    if not ref:
        return schema
    if not ref.startswith("#/"):
        raise RegistryError(f"unsupported $ref {ref!r}")
    node = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def _validate(value, schema: dict, root: dict, path: str, errors: list[str]) -> None:
    schema = _resolve(schema, root)

    if "enum" in schema:
        if value not in schema["enum"]:
            errors.append(f"{path}: {value!r} is not one of {schema['enum']}")
        return

    expected = schema.get("type")
    if expected is not None:
        options = expected if isinstance(expected, list) else [expected]
        if not any(_type_ok(value, o) for o in options):
            errors.append(f"{path}: expected {expected}, got {type(value).__name__}")
            return

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than {schema['minLength']} characters")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: below minimum {schema['minimum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        item_schema = schema.get("items")
        if item_schema:
            for i, item in enumerate(value):
                _validate(item, item_schema, root, f"{path}[{i}]", errors)
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required key '{key}'")
        props = schema.get("properties", {})
        extra = schema.get("additionalProperties")
        for key, item in sorted(value.items()):
            sub = f"{path}.{key}" if path else key
            if key in props:
                _validate(item, props[key], root, sub, errors)
            elif isinstance(extra, dict):
                _validate(item, extra, root, sub, errors)
            elif extra is False:
                errors.append(f"{path}: unknown key '{key}'")


def validate(document: dict, schema: dict | None = None) -> None:
    schema = schema or json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    errors: list[str] = []
    _validate(document, schema, schema, "", errors)
    if errors:
        shown = "\n  ".join(errors[:40])
        more = "" if len(errors) <= 40 else f"\n  ... and {len(errors) - 40} more"
        raise RegistryError(f"registry.yaml does not match its schema:\n  {shown}{more}")


# --- the build --------------------------------------------------------------------

def load_yaml() -> dict:
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - only without PyYAML
        raise RegistryError(
            "PyYAML is required to BUILD the registry. Reading the built registry.json "
            "needs nothing but the standard library."
        ) from exc
    return yaml.safe_load(YAML_PATH.read_text(encoding="utf-8"))


def build(document: dict | None = None) -> dict:
    """Validate the YAML and join Prisma's type and default onto every field."""
    from prisma_project_columns import project_columns

    doc = document if document is not None else load_yaml()
    validate(doc)

    columns = project_columns()
    fields = doc["fields"]

    missing = sorted(set(columns) - set(fields))
    ghosts = sorted(set(fields) - set(columns))
    if missing:
        raise RegistryError(
            f"{len(missing)} Prisma Project column(s) have no registry entry: "
            f"{', '.join(missing[:10])}{' ...' if len(missing) > 10 else ''}"
        )
    if ghosts:
        raise RegistryError(
            f"{len(ghosts)} registry entr(ies) name a column Prisma does not have: "
            f"{', '.join(ghosts[:10])}{' ...' if len(ghosts) > 10 else ''}"
        )

    tool_sections = {name: tool.get("form_section") for name, tool in doc["tools"].items()}

    out_fields: dict[str, dict] = {}
    for name in sorted(fields):
        col = columns[name]
        entry = dict(fields[name])
        # A field is rendered beside the other settings of the tool it configures,
        # so the section is the TOOL's unless the field names its own. An explicit
        # null survives the join and means "no input anywhere", which is what the
        # parity test reads to tell a deliberate omission from a forgotten one.
        if "form_section" not in entry:
            entry["form_section"] = tool_sections.get(entry["tool"])
        entry["type"] = col.kind
        entry["prisma_type"] = col.type + ("[]" if col.is_list else "")
        entry["optional"] = col.optional
        entry["default"] = col.default_value
        entry["has_default"] = col.default_raw is not None
        out_fields[name] = {k: entry[k] for k in sorted(entry)}

    tools = {name: {k: v for k, v in sorted(tool.items())} for name, tool in sorted(doc["tools"].items())}
    runtime = {name: {k: v for k, v in sorted(r.items())} for name, r in sorted(doc["runtime_only"].items())}

    return {
        "version": doc["version"],
        "fields": out_fields,
        "runtime_only": runtime,
        "tools": tools,
    }


HEADER = (
    "GENERATED FILE - DO NOT EDIT. Source: recon_settings/registry.yaml. "
    "Rebuild with: python3 recon_settings/build.py"
)


def serialise(registry: dict) -> str:
    return json.dumps({"_generated": HEADER, **registry}, indent=1, sort_keys=False) + "\n"


def main(argv: list[str]) -> int:
    check = "--check" in argv
    try:
        text = serialise(build())
    except RegistryError as exc:
        print(f"registry build FAILED: {exc}", file=sys.stderr)
        return 2

    targets = {JSON_PATH: text, WEBAPP_JSON_PATH: text}

    # The prompt is generated from the registry AS JUST BUILT, not from whatever
    # registry.json happens to be on disk, so one run cannot leave the two
    # artifacts describing different field sets.
    if check:
        stale = [p for p, body in targets.items()
                 if not p.exists() or p.read_text(encoding="utf-8") != body]
        prompt_text = _prompt_from(text)
        if not ROE_PROMPT_PATH.exists() or ROE_PROMPT_PATH.read_text(encoding="utf-8") != prompt_text:
            stale.append(ROE_PROMPT_PATH)
        if stale:
            names = ", ".join(str(p.relative_to(REPO_ROOT)) for p in stale)
            print(
                f"registry artifact is STALE: {names}\n"
                f"Run: python3 recon_settings/build.py",
                file=sys.stderr,
            )
            return 1
        print("registry artifacts are up to date")
        return 0

    for path, body in targets.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        # Generated registry bytes are hashed into the RoE prompt artifact.
        # Keep their on-disk line endings stable across Windows and Linux, or
        # the embedded digest changes after Git normalizes CRLF to LF.
        path.write_text(body, encoding="utf-8", newline="\n")
    ROE_PROMPT_PATH.write_text(_prompt_from(text), encoding="utf-8", newline="\n")

    registry = json.loads(text)
    print(
        f"wrote {len(targets) + 1} artifact(s): "
        f"{len(registry['fields'])} fields, {len(registry['tools'])} tools, "
        f"{len(registry['runtime_only'])} runtime-only keys"
    )
    return 0


def _prompt_from(registry_text: str) -> str:
    """Render the prompt against the registry text this run produced.

    The loader caches, and it reads the file, so a build that wrote a new
    registry and then rendered would otherwise render from the PREVIOUS bytes on
    the first run after a change. Writing the registry first and dropping the
    cache is what keeps the digest in the prompt equal to the digest of the file
    beside it.
    """
    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    JSON_PATH.write_text(registry_text, encoding="utf-8", newline="\n")
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    from recon_settings.loader import reload_registry  # noqa: PLC0415
    from recon_settings.roe_prompt import render_module  # noqa: PLC0415

    reload_registry()
    return render_module()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
