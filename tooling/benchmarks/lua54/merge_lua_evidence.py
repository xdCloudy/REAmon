#!/usr/bin/env python3
"""Bind Lua persistence and runtime evidence to the enrolled fixture hash."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


class EvidenceError(ValueError):
    pass


def load(path: Path):
    with path.open(encoding='utf-8') as source:
        return json.load(source)


def merge(*, fixture_manifest_path: Path, database_path: Path, behavior_path: Path):
    manifest = load(fixture_manifest_path)
    database = load(database_path)
    behavior = load(behavior_path)
    fixture_id = manifest.get('fixtureId')
    artifact_sha = manifest.get('artifact', {}).get('sha256')
    source_sha = manifest.get('groundTruth', {}).get('sha256')
    if not re.fullmatch(r'[a-f0-9]{64}', str(artifact_sha)):
        raise EvidenceError('fixture manifest artifact SHA-256 is invalid')
    if not re.fullmatch(r'[a-f0-9]{64}', str(source_sha)):
        raise EvidenceError('fixture manifest ground-truth SHA-256 is invalid')
    if database.get('fixtureId') != fixture_id or database.get('artifactSha256') != artifact_sha:
        raise EvidenceError('database evidence does not match the enrolled Lua fixture')
    if behavior.get('fixtureId') != fixture_id:
        raise EvidenceError('runtime evidence does not match the enrolled Lua fixture')
    if database.get('recoveredSourceSha256') != behavior.get('recoveredSourceSha256'):
        raise EvidenceError('runtime evidence was not produced from the source persisted by the database run')
    if behavior.get('originalSourceSha256') != source_sha:
        raise EvidenceError('runtime evidence original source differs from the enrollment manifest')
    if not database.get('recoveredSourceRelativePath') or not database.get('persistedSourceHashVerified'):
        raise EvidenceError('database evidence lacks verified persisted source provenance')
    if behavior.get('recoveredSourceParsed') is not True:
        raise EvidenceError('recovered Lua source did not pass the matching compiler parser')
    if behavior.get('runtimeMatchedInputs') != 10 or len(behavior.get('inputs', [])) != 10:
        raise EvidenceError('Lua sampled runtime oracle did not measure all ten declared inputs')
    database_metrics = database.get('metrics')
    behavior_metrics = behavior.get('metrics')
    if not isinstance(database_metrics, dict) or not isinstance(behavior_metrics, dict):
        raise EvidenceError('Lua evidence is missing metric records')
    expected_database_metrics = {
        'recovered_source_files', 'persisted_function_prototypes',
        'persisted_contains_relationships', 'source_inventory_complete',
    }
    expected_behavior_metrics = {'recovered_source_parse', 'runtime_oracle', 'sampled_behavior_oracle'}
    if set(database_metrics) != expected_database_metrics or set(behavior_metrics) != expected_behavior_metrics:
        raise EvidenceError('Lua evidence metric inventory differs from the evaluation contract')
    metrics = {**database_metrics, **behavior_metrics}
    metrics['source_persistence_integrity'] = {
        'state': 'MEASURED',
        'denominator': 1,
        'value': 1,
    }
    return {
        'schemaVersion': 1,
        'fixtureId': fixture_id,
        'artifactSha256': artifact_sha,
        'provider': database.get('provider'),
        'dialect': database.get('dialect'),
        'recoveredSourceSha256': database.get('recoveredSourceSha256'),
        'persistedSourceHashVerified': True,
        'metrics': metrics,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-manifest', required=True, type=Path)
    parser.add_argument('--database-evidence', required=True, type=Path)
    parser.add_argument('--behavior-evidence', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = merge(
            fixture_manifest_path=args.fixture_manifest,
            database_path=args.database_evidence,
            behavior_path=args.behavior_evidence,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x', encoding='utf-8', newline='\n') as output:
            json.dump(result, output, indent=2, sort_keys=True)
            output.write('\n')
        print(f"merged complete Lua evidence for {result['fixtureId']} into {args.output.resolve()}")
        return 0
    except (EvidenceError, OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f'merge_lua_evidence: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
