import json
import os
import pathlib
import subprocess
import zipfile

root = pathlib.Path('/data/reamon-derived')
proxy = root / 'file-proxy' / 'example.test' / 'dep' / '@v'
project = root / 'module-seed-project'
cache = root / 'module-cache'
proxy.mkdir(parents=True, exist_ok=True)
project.mkdir(parents=True, exist_ok=True)
version = 'v1.0.0'
module_source = 'module example.test/dep\n\ngo 1.24\n'
package_source = 'package dep\nconst Value = 7\n'
(proxy / f'{version}.info').write_text(json.dumps({'Version': version, 'Time': '2026-01-01T00:00:00Z'}), encoding='utf8')
(proxy / f'{version}.mod').write_text(module_source, encoding='utf8')
with zipfile.ZipFile(proxy / f'{version}.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(f'example.test/dep@{version}/go.mod', module_source)
    archive.writestr(f'example.test/dep@{version}/dep.go', package_source)

go_mod = 'module example.test/fixture\n\ngo 1.24\n\nrequire example.test/dep v1.0.0\n'
(project / 'go.mod').write_text(go_mod, encoding='utf8')
env = dict(os.environ)
env.update({
    'GOPROXY': f'file://{proxy.parents[2]}',
    'GOSUMDB': 'off',
    'GOMODCACHE': str(cache),
    'GOFLAGS': '',
    'GO111MODULE': 'on',
})
subprocess.run(['go', 'mod', 'download', 'example.test/dep@v1.0.0'], cwd=project, env=env, check=True)
(root / 'go.mod').write_text(go_mod, encoding='utf8')
(root / 'go.sum').write_bytes((project / 'go.sum').read_bytes())
