"""Build plugin zip and verify both release archives contain only distribution files."""
import os
import stat
import subprocess
import sys
import zipfile

version = sys.argv[1]
plugin = f'pico-ai-bridge-{version}-plugin.zip'
mcpb = f'pico-ai-bridge-{version}.mcpb'

def tracked(*paths):
    output = subprocess.run(['git', 'ls-files', '-z', '--', *paths], check=True, capture_output=True).stdout
    return [os.fsdecode(path) for path in output.split(b'\0') if path]

plugin_files = sorted(set(tracked('.claude-plugin', 'server', 'skills') +
    ['package.json', 'README.md', 'README.ja.md', 'LICENSE', 'PRIVACY.md']))
for path in plugin_files:
    if os.path.islink(path) or not stat.S_ISREG(os.stat(path).st_mode):
        raise ValueError(f'plugin entry is not a regular file: {path}')
with zipfile.ZipFile(plugin, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in plugin_files:
        archive.write(path, path)

tracked_files = set(tracked())
required = {'server/index.js', 'manifest.json', 'package.json', 'README.md', 'LICENSE'}
for path in [mcpb, plugin]:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        print(f'{path}: {len(names)} entries')
        for name in names:
            print(name)
        assert ('README.ja.md' in names) == (path == plugin), f'{path} has the wrong Japanese README inclusion'
        if path == plugin:
            assert sorted(names) == plugin_files, f'{path} entries differ from the plugin file list'
        else:
            assert set(names) <= tracked_files and len(names) == len(set(names)), f'{path} contains untracked or duplicate entries'
            assert required <= set(names), f'{path} lacks required entries: {sorted(required - set(names))}'
            assert not any(name.startswith(('dev/', 'test/', 'scripts/', '.github/', '.claude-plugin/', 'skills/', 'node_modules/')) for name in names), f'{path} contains excluded entries'
