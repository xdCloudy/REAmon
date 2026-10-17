#@category REAmon
# Applies uniquely outlined, accepted function names from a REAmon Ghidra bundle.
# This script never rebases addresses and refuses a different source binary.

import hashlib
import json
import os
import re

from ghidra.program.model.symbol import SourceType

MAX_BUNDLE_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_NATIVE_ANNOTATION_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 25000
NAME_PATTERN = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$')

try:
    STRING_TYPES = (basestring,)
except NameError:
    STRING_TYPES = (str,)


def fail(message):
    printerr("REAmon annotation import stopped: " + message)
    raise Exception(message)


def sha256_file(file_path):
    digest = hashlib.sha256()
    with open(file_path, 'rb') as source_file:
        while True:
            chunk = source_file.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


bundle_manifest_file = askFile("Select the REAmon source bundle manifest.json", "Open")
if bundle_manifest_file is None:
    fail("No source bundle manifest was selected.")
bundle_manifest_path = bundle_manifest_file.getAbsolutePath()
if not os.path.isfile(bundle_manifest_path) or os.path.getsize(bundle_manifest_path) > MAX_BUNDLE_MANIFEST_BYTES:
    fail("The source bundle manifest is missing or exceeds the 64 MiB import limit.")

try:
    with open(bundle_manifest_path, 'rb') as source_file:
        bundle_manifest = json.load(source_file)
except Exception as error:
    fail("The source bundle manifest is not valid JSON: " + str(error))

annotation_metadata = bundle_manifest.get('nativeAnnotations') if isinstance(bundle_manifest, dict) else None
if not isinstance(annotation_metadata, dict) or annotation_metadata.get('path') != 'native-annotations.json':
    fail("The source bundle manifest does not reference native-annotations.json.")
annotation_path = os.path.join(os.path.dirname(bundle_manifest_path), 'native-annotations.json')
if not os.path.isfile(annotation_path) or os.path.getsize(annotation_path) > MAX_NATIVE_ANNOTATION_BYTES:
    fail("The native annotation sidecar is missing or exceeds the 8 MiB import limit.")
try:
    if sha256_file(annotation_path).lower() != str(annotation_metadata.get('sha256', '')).lower():
        fail("The native annotation sidecar does not match the hash recorded in manifest.json.")
    with open(annotation_path, 'rb') as source_file:
        manifest = json.load(source_file)
except Exception as error:
    fail("Could not validate or parse the native annotation sidecar: " + str(error))

if not isinstance(manifest, dict) or manifest.get('schema') != 'reamon.native-annotations.v1':
    fail("Unsupported REAmon native annotation schema.")
analysis = manifest.get('analysis')
if not isinstance(analysis, dict) or analysis.get('provider') != 'reamon-ghidra':
    fail("The native annotation sidecar was not produced by the Ghidra provider.")
binary = manifest.get('binary')
expected_hash = binary.get('sha256') if isinstance(binary, dict) else None
if not isinstance(expected_hash, STRING_TYPES) or not re.match(r'^[a-fA-F0-9]{64}$', expected_hash):
    fail("The manifest has no valid exact-binary SHA-256.")

executable_path = currentProgram.getExecutablePath()
if not executable_path or not os.path.isfile(executable_path):
    fail("Ghidra does not have a readable original executable path for this program.")
try:
    loaded_hash = sha256_file(executable_path)
except Exception as error:
    fail("Could not hash Ghidra's original executable: " + str(error))
if loaded_hash.lower() != expected_hash.lower():
    fail("The loaded Ghidra program does not match the manifest's exact input binary SHA-256.")

try:
    recorded_hash = currentProgram.getExecutableSHA256()
except Exception:
    recorded_hash = None
if recorded_hash and recorded_hash.lower() != loaded_hash.lower():
    fail("Ghidra's recorded executable SHA-256 disagrees with its executable path.")

entries = manifest.get('entries')
if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
    fail("The manifest entries are missing or exceed the import limit.")

pending = []
already_applied = 0
skipped = 0
address_factory = currentProgram.getAddressFactory()
function_manager = currentProgram.getFunctionManager()
for entry in entries:
    if not isinstance(entry, dict) or entry.get('addressKind') != 'ghidra-address':
        skipped += 1
        continue
    declaration = entry.get('functionDeclaration')
    if not isinstance(declaration, dict) or declaration.get('mapping') != 'unique function declaration in the exact accepted source file':
        skipped += 1
        continue
    new_name = declaration.get('name')
    address_text = entry.get('address')
    original_name = entry.get('originalName')
    if not isinstance(new_name, STRING_TYPES) or not NAME_PATTERN.match(new_name):
        skipped += 1
        continue
    if not isinstance(address_text, STRING_TYPES) or not isinstance(original_name, STRING_TYPES):
        skipped += 1
        continue
    try:
        address = address_factory.getAddress(address_text)
        function = function_manager.getFunctionAt(address) if address is not None else None
    except Exception:
        function = None
    if function is None:
        skipped += 1
        continue
    current_name = function.getName()
    expected_name = original_name.rsplit('::', 1)[-1].split('(', 1)[0]
    if current_name == new_name:
        already_applied += 1
        continue
    if current_name != expected_name:
        skipped += 1
        continue
    pending.append((function, new_name, address_text))

if not pending:
    printerr("REAmon annotation import: no uniquely mapped function names are safe to apply; skipped=%d already_applied=%d" % (skipped, already_applied))
    fail("No uniquely mapped function names are safe to apply.")

if not askYesNo("Apply REAmon function names", "The exact input SHA-256 matches. Apply %d accepted function names to this Ghidra program?\n\nNo addresses will be rebased. Functions whose current names changed or whose targets are missing will be skipped." % len(pending)):
    fail("Import cancelled by reviewer.")

transaction_id = currentProgram.startTransaction("Import REAmon accepted function names")
applied = 0
failed = 0
commit = False
try:
    for function, new_name, address_text in pending:
        try:
            function.setName(new_name, SourceType.USER_DEFINED)
            applied += 1
        except Exception as error:
            failed += 1
            printerr("Skipped %s at %s: %s" % (new_name, address_text, str(error)))
    commit = True
finally:
    currentProgram.endTransaction(transaction_id, commit)

print("REAmon annotation import complete: applied=%d already_applied=%d skipped=%d failed=%d" % (applied, already_applied, skipped, failed))
