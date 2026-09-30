"""Start each release archive against a local mock Pico server."""
import json
import os
from pathlib import Path
from queue import Empty, Queue
import re
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from time import monotonic
from zipfile import ZipFile


class MockPico(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/api/version':
            self.send_error(404)
            return
        expected = [] if self.server.expected_authorization is None else [self.server.expected_authorization]
        if self.headers.get_all('Authorization', []) != expected:
            self.send_error(401)
            return
        body = json.dumps({
            'bundle_identifier': 'com.example.PicoMock',
            'version': '1.4.23', 'build': '147', 'name': 'Pico Mock'
        }).encode('ascii')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def launch_config(archive, directory, base_url, configured):
    plugin = archive.endswith('-plugin.zip')
    path = '.claude-plugin/plugin.json' if plugin else 'manifest.json'
    manifest = json.loads((Path(directory) / path).read_text(encoding='utf-8'))
    config = manifest['mcpServers']['pico-ai-bridge'] if plugin else manifest['server']['mcp_config']
    declared = manifest['userConfig' if plugin else 'user_config']
    defaults = {'api_key': '', 'timeout_ms': 300000, 'max_concurrent_requests': 1}
    if plugin:
        defaults['base_url'] = 'http://localhost:11434'
    for key, expected in defaults.items():
        actual = declared[key].get('default')
        assert type(actual) is type(expected) and actual == expected, f'{archive}: {key} default: {actual!r}'
    values = {'base_url': base_url}
    if configured:
        values.update(api_key='archive-smoke-key', timeout_ms=20000, max_concurrent_requests=2)
    else:
        for key, field in declared.items():
            if key not in values:
                if 'default' not in field:
                    raise AssertionError(f'{archive}: missing default for {key}')
                values[key] = field['default']
    roots = {'CLAUDE_PLUGIN_ROOT': directory} if plugin else {'__dirname': directory}
    def substitute(value):
        def replace(match):
            key = match.group(1)
            if key.startswith('user_config.') and key[12:] in values:
                return str(values[key[12:]])
            if key in roots:
                return roots[key]
            raise AssertionError(f'{archive}: unresolved placeholder ${{{key}}}')
        result = re.sub(r'\$\{([^}]+)\}', replace, str(value))
        if '${' in result:
            raise AssertionError(f'{archive}: unresolved placeholder in {result}')
        return result
    command = substitute(config['command'])
    if command == 'node':
        command = shutil.which('node')
        if command is None:
            raise AssertionError(f'{archive}: node executable not found')
    args = [substitute(arg) for arg in config['args']]
    env = {**os.environ, **{key: substitute(value) for key, value in config.get('env', {}).items()}}
    expected_env = {'PICO_BASE_URL': base_url, 'PICO_API_KEY': 'archive-smoke-key' if configured else '',
                    'PICO_TIMEOUT_MS': '20000' if configured else '300000',
                    'PICO_MAX_CONCURRENT_REQUESTS': '2' if configured else '1'}
    for key, expected in expected_env.items():
        assert env.get(key) == expected, f'{archive}: {key}: {env.get(key)!r} != {expected!r}'
    return [command, *args], env


def smoke(archive, base_url, configured, server):
    server.expected_authorization = 'Bearer archive-smoke-key' if configured else None
    with tempfile.TemporaryDirectory(prefix='pico-archive-smoke-') as directory:
        with ZipFile(archive) as packed:
            packed.extractall(directory)
        command, env = launch_config(archive, directory, base_url, configured)
        for arg in command[1:]:
            if arg.endswith('.js') and not Path(arg).is_file():
                raise AssertionError(f'{archive}: missing server entry {arg}')
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(command, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=errors, env=env)
            deadline = monotonic() + 20
            try:
                requests = [
                    {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                        'protocolVersion': '2025-11-25', 'capabilities': {},
                        'clientInfo': {'name': 'archive-smoke', 'version': '1'}}},
                    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {
                        'name': 'pico_server_info', 'arguments': {}}}
                ]
                process.stdin.write(('\n'.join(json.dumps(item) for item in requests) + '\n').encode('utf-8'))
                process.stdin.flush()
                lines = Queue()
                def read_lines():
                    for line in process.stdout:
                        lines.put(line)
                    lines.put(None)
                reader = Thread(target=read_lines, daemon=True)
                reader.start()
                reply = None
                initialized = False
                while reply is None or not initialized:
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise TimeoutError(f'{archive}: no tools/call reply within 20 seconds')
                    try:
                        line = lines.get(timeout=remaining)
                    except Empty:
                        raise TimeoutError(f'{archive}: no tools/call reply within 20 seconds') from None
                    if line is None:
                        raise AssertionError(f'{archive}: server exited before tools/call reply')
                    message = json.loads(line)
                    if message.get('id') == 1:
                        assert 'result' in message, f'{archive}: initialize failed: {message}'
                        initialized = True
                    elif message.get('id') == 2:
                        reply = message
                process.stdin.close()
                if process.wait(timeout=max(0.1, deadline - monotonic())) != 0:
                    raise AssertionError(f'{archive}: server exited with {process.returncode}')
                reader.join(timeout=max(0.1, deadline - monotonic()))
                if reader.is_alive():
                    raise TimeoutError(f'{archive}: stdout reader did not finish')
                result = reply['result']
                assert not result.get('isError'), f'{archive}: {result}'
                assert result['structuredContent']['version'] == '1.4.23', f'{archive}: {result}'
                print(f'{archive} ({"configured" if configured else "defaults"}): smoke passed')
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: smoke-artifacts.py VERSION')
    server = ThreadingHTTPServer(('127.0.0.1', 0), MockPico)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f'http://127.0.0.1:{server.server_port}'
        version = sys.argv[1]
        for archive in (f'pico-ai-bridge-{version}.mcpb',
                        f'pico-ai-bridge-{version}-plugin.zip'):
            for configured in (True, False):
                smoke(archive, base_url, configured, server)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
