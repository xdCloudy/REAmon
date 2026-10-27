"""L1 Supply-Chain scan runner (artifact producer side).

v1 input: an operator-uploaded SBOM / lockfile. Runs osv-scanner OFFLINE (static,
no-install, no network - safe per plan S1) on the file, assembles the standard
artifact, and validates it through the DIRTY->CLEAN boundary before persistence.
GitHub-repo cloning and GuardDog deep-analysis (which need the secret-free
DIRTY analyzer) are deferred to v2; this runner never downloads a tarball or
runs a package manager.

Input safety (S7): the uploaded filename is treated as a basename only (no path
traversal), must carry an allowlisted extension, and must live inside the mounted
uploads directory.
"""

import os

# supply_chain_common is mounted at /app like graph_db.
from supply_chain_common import osv_runner
from supply_chain_common.artifact import (
    empty_artifact, add_osv_findings, osv_mode_for_path,
)
from supply_chain_common.security import validate_artifact, ArtifactError

# Manifest/SBOM filenames osv-scanner understands, plus SBOM extensions.
_ALLOWED_EXTS = (".json", ".xml", ".txt", ".lock", ".toml", ".mod", ".sum")
_ALLOWED_BASENAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "requirements.txt",
    "poetry.lock", "Pipfile.lock", "go.mod", "go.sum", "Cargo.lock",
    "composer.lock", "Gemfile.lock", "packages.lock.json", "pom.xml",
}


class SupplyChainInputError(ValueError):
    pass


def resolve_input_path(uploads_dir, sbom_file):
    """Validate + resolve the uploaded file to an absolute path, or raise.

    Rejects path traversal and disallowed extensions (S7). The file must exist
    inside `uploads_dir`.
    """
    if not sbom_file:
        raise SupplyChainInputError("no input file configured")
    base = os.path.basename(sbom_file)
    if base != sbom_file or ".." in sbom_file or sbom_file.startswith("/"):
        raise SupplyChainInputError("input must be a bare filename, not a path")
    lowered = base.lower()
    if base not in _ALLOWED_BASENAMES and not lowered.endswith(_ALLOWED_EXTS):
        raise SupplyChainInputError("disallowed input extension: {}".format(base))
    path = os.path.join(uploads_dir, base)
    if not os.path.isfile(path):
        raise SupplyChainInputError("input file not found: {}".format(base))
    return path


class SupplyChainRunner:
    def __init__(self, *, uploads_dir, sbom_file, db_path, project_id,
                 ecosystems=None, osv=osv_runner, repo_dir=None):
        self.uploads_dir = uploads_dir
        self.sbom_file = sbom_file
        self.db_path = db_path
        self.project_id = project_id
        self.ecosystems = set(ecosystems or [])
        self._osv = osv  # injectable for tests
        # When set, the input is a cloned repository checkout rather than a
        # single uploaded file: osv-scanner walks it and picks up EVERY
        # lockfile it contains, which is the point of the GitHub source.
        self.repo_dir = repo_dir
        self.stats = {"packages": 0, "malicious": 0, "vulnerable": 0,
                      "errors": []}

    def run(self):
        """Scan the input and return a validated artifact dict."""
        if self.repo_dir:
            path, mode = self.repo_dir, "dir"
        else:
            try:
                path = resolve_input_path(self.uploads_dir, self.sbom_file)
            except SupplyChainInputError as exc:
                art = empty_artifact()
                art["errors"].append(str(exc))
                return validate_artifact(art)
            mode = osv_mode_for_path(path)
        result = self._osv.run_osv_scan(path, mode=mode, db_path=self.db_path)

        artifact = empty_artifact(mode)
        if result.get("error"):
            artifact["errors"].append("osv: {}".format(result["error"]))
        add_osv_findings(artifact, result.get("parsed") or {})

        # Optional ecosystem allow-filter for the persisted result.
        if self.ecosystems:
            artifact["packages"] = [p for p in artifact["packages"]
                                    if p.get("ecosystem") in self.ecosystems]
            artifact["malicious"] = [m for m in artifact["malicious"]
                                     if m.get("ecosystem") in self.ecosystems]
            artifact["vulnerable"] = [v for v in artifact["vulnerable"]
                                      if v.get("ecosystem") in self.ecosystems]

        self.stats["packages"] = len(artifact["packages"])
        self.stats["malicious"] = len(artifact["malicious"])
        self.stats["vulnerable"] = len(artifact["vulnerable"])

        try:
            return validate_artifact(artifact)
        except ArtifactError as exc:
            # A self-produced artifact should never fail validation; surface it.
            safe = empty_artifact()
            safe["errors"].append("artifact validation failed: {}".format(exc))
            return validate_artifact(safe)
