#!/usr/bin/env python3
"""No-network-dependencies integration test: real monitor binary, fake HTTP backends."""
import base64
import hashlib
import http.server
import json
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def b64(data):
    return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')


NOW = int(time.time())
ACCESS_TOKEN = f'{b64({"alg":"none","typ":"JWT"})}.{b64({"iat":NOW,"exp":NOW+3600})}.test-signature'
TOKEN = secrets.token_urlsafe(48)
CLIENT_SECRET = secrets.token_urlsafe(48)


class MockIdentity(http.server.BaseHTTPRequestHandler):
    challenge = None
    verified = 0
    signaling = 0

    def reply(self, status, content):
        encoded = json.dumps(content).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == '/oidc/userinfo':
            ok = self.headers.get('authorization') == f'Bearer {ACCESS_TOKEN}'
            if ok:
                type(self).verified += 1
            self.reply(200 if ok else 401, {'sub': 'operator'} if ok else {'error': 'invalid_token'})
        elif self.path == '/health':
            self.reply(200, {'status': 'ok', 'codec': 'av1'})
        else:
            self.reply(404, {'error': 'not_found'})

    def do_POST(self):
        length = int(self.headers.get('content-length', 0))
        body = self.rfile.read(length)
        if self.path == '/oidc/token':
            form = urllib.parse.parse_qs(body.decode())
            code_verifier = form.get('code_verifier', [''])[0]
            challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).decode().rstrip('=')
            ok = (form.get('grant_type') == ['authorization_code']
                  and form.get('client_id') == ['mcpmonitor-web']
                  and form.get('client_secret') == [CLIENT_SECRET]
                  and form.get('code') == ['valid-code']
                  and self.challenge == challenge)
            self.reply(200 if ok else 400,
                       {'access_token': ACCESS_TOKEN, 'expires_in': 3600, 'token_type': 'Bearer'} if ok
                       else {'error': 'invalid_grant'})
        elif self.path == '/dc':
            ok = (self.headers.get('x-native-live-public') == '1'
                  and json.loads(body)['sdp'] == 'offer-sdp')
            if ok:
                type(self).signaling += 1
            self.reply(200 if ok else 400,
                       {'type': 'answer', 'sdp': 'answer-sdp', 'codec': 'av1'} if ok else {'error': 'invalid'})
        else:
            self.reply(404, {'error': 'not_found'})

    def log_message(self, *_):
        pass


class MockCodex(http.server.BaseHTTPRequestHandler):
    ack_count = 0
    attempts = 0

    def do_GET(self):
        if self.path != '/monitor/v2/events' or self.headers.get('authorization') != f'Bearer {TOKEN}':
            self.send_error(401)
            return
        type(self).attempts += 1
        now = int(time.time() * 1000)
        events = [
            dict(schema_version=3, service='codex-mcp', boot_id='test-boot', sequence=0,
                 event='hello', data={'active_call_ids':[], 'terminal_replay_call_ids':[]}, emitted_at=now),
            dict(schema_version=3, service='codex-mcp', boot_id='test-boot', sequence=1,
                 event='call_started', call_id='http-test-call', emitted_at=now,
                 data={'tool':'exec_command', 'kind':'commandExecution',
                       'arguments':{'cmd':'echo standalone'},'started_at':now,'background':False}),
            dict(schema_version=3, service='codex-mcp', boot_id='test-boot', sequence=2,
                 event='call_finished', call_id='http-test-call', emitted_at=now+50,
                 data={'tool':'exec_command', 'kind':'commandExecution',
                       'arguments':{'cmd':'echo standalone'}, 'started_at':now,
                       'status':'completed','ended_at':now+50,'duration_ms':50,
                       'background':False, 'exit_code':0, 'output':'standalone\n'}),
        ]
        body = b''.join(('data: ' + json.dumps(event) + '\n\n').encode() for event in events)
        self.send_response(200)
        self.send_header('content-type','text/event-stream')
        self.send_header('content-length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/monitor/v2/ack' or self.headers.get('authorization') != f'Bearer {TOKEN}':
            self.send_error(401)
            return
        body = json.loads(self.rfile.read(int(self.headers.get('content-length',0))))
        if body.get('boot_id') == 'test-boot' and body.get('sequence') == 2:
            type(self).ack_count += 1
        out = b'{"ok":true}'
        self.send_response(200)
        self.send_header('content-type','application/json')
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self,*_):
        pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())


def request(base, path, data=None, headers=None, method=None):
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        headers = {**(headers or {}), 'Content-Type':'application/json'}
    req = urllib.request.Request(base+path,data=data,headers=headers or {},method=method)
    try:
        response = OPENER.open(req,timeout=4)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read()
        try:
            body = json.loads(body)
        except (ValueError,UnicodeError):
            pass
        return response.status, response.headers, body


def free_port():
    from socket import socket
    with socket() as s:
        s.bind(('127.0.0.1',0))
        return s.getsockname()[1]


def start_monitor(binary, config, port, logfile):
    proc = subprocess.Popen([str(binary),str(config),f'127.0.0.1:{port}'],
                            stdout=logfile,stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        if proc.poll() is not None:
            raise AssertionError(f'mcpmonitor process exited {proc.returncode}')
        try:
            if request(base,'/mcpmonitor/api/me')[0] == 200:
                return proc
        except (OSError,TimeoutError):
            pass
        time.sleep(.05)
    raise AssertionError('mcpmonitor HTTP listener did not start')


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: standalone_http.py /absolute/path/to/mcpmonitor')
    binary = Path(sys.argv[1]).resolve()
    assert binary.is_file(), binary
    servers = []
    processes = []
    try:
        for handler in [MockIdentity,MockCodex]:
            server = http.server.ThreadingHTTPServer(('127.0.0.1',0),handler)
            thread = threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            servers.append(server)
        identity, codex = servers
        with tempfile.TemporaryDirectory(prefix='mcpmonitor-http-test-') as directory:
            root = Path(directory)
            token_path = root/'observer-token'
            token_path.write_text(TOKEN)
            port = free_port()
            base = f'http://127.0.0.1:{port}'
            origin = f'http://127.0.0.1:{identity.server_port}'
            oidc_config = root/'oidc.json'
            oidc_config.write_text(json.dumps({
                'issuer':origin+'/oidc', 'client_id':'mcpmonitor-web',
                'client_secret':CLIENT_SECRET, 'redirect_uri':base+'/mcpmonitor/auth/callback',
                'subject':'operator', 'scopes':'openid profile email', 'secure_cookie':False
            }))
            config = root/'config.json'
            config.write_text(json.dumps({
                'public_origin':base, 'codex_http_url':f'http://127.0.0.1:{codex.server_port}',
                'upstream_token_file':str(token_path), 'oidc_config':str(oidc_config),
                'secure_cookie':False, 'database':str(root/'history.sqlite'),
                'native_live_url':origin
            }))
            with (root/'monitor.log').open('wb') as logfile:
                proc = start_monitor(binary,config,port,logfile)
                processes.append(proc)
                status, _, body = request(base,'/mcpmonitor/api/me')
                assert status == 200 and body == {'authenticated':False,'auth_mode':'oidc'},body
                assert request(base,'/mcpmonitor/api/calls')[0] == 401
                status, headers, _ = request(base,'/mcpmonitor/auth/start')
                assert status in [302,303,307], status
                location = urllib.parse.urlparse(headers['location'])
                query = urllib.parse.parse_qs(location.query)
                assert query['code_challenge_method'] == ['S256']
                assert location.path == '/oidc/authorize'
                MockIdentity.challenge = query['code_challenge'][0]
                state = query['state'][0]
                cookie = headers['set-cookie'].split(';',1)[0]
                status, headers, _ = request(base,
                    '/mcpmonitor/auth/callback?'+urllib.parse.urlencode({'code':'valid-code','state':state}),
                    headers={'Cookie':cookie})
                assert status in [302,303,307], status
                session = headers['set-cookie'].split(';',1)[0]
                assert session.startswith('mcpmonitor_session=')
                auth_header = {'Cookie':session}
                assert request(base,'/mcpmonitor/api/me',headers=auth_header)[2]['authenticated']
                assert MockIdentity.verified >= 1
                for _ in range(80):
                    status, _, body = request(base,'/mcpmonitor/api/calls',headers=auth_header)
                    if status==200 and any(call['id']=='http-test-call' and call['status']=='completed' for call in body.get('calls',[])) and MockCodex.ack_count:
                        break
                    time.sleep(.1)
                assert status==200 and len(body['calls'])>0 and MockCodex.ack_count, (status,body,MockCodex.ack_count)
                status, _, detail = request(base,'/mcpmonitor/api/calls/http-test-call',headers=auth_header)
                assert status==200 and detail['id']=='http-test-call', (status,detail)
                assert request(base,'/mcpmonitor/browser/video/dc',{'sdp':'x'},auth_header)[0] == 501
                assert request(base,'/mcpmonitor/native/restart',{},auth_header)[0] == 501
                assert request(base,'/mcpmonitor/native/health',headers=auth_header)[0] == 200
                status, _, dc = request(base,'/mcpmonitor/native/dc',{'sdp':'offer-sdp'},auth_header)
                assert status==200 and dc['sdp']=='answer-sdp' and MockIdentity.signaling>=1
                proc.terminate()
                proc.wait(timeout=8)
                processes.remove(proc)
                proc = start_monitor(binary,config,port,logfile)
                processes.append(proc)
                status, _, body = request(base,'/mcpmonitor/api/calls/http-test-call',headers=auth_header)
                assert status == 200 and body['id']=='http-test-call'
                print('PASS: OIDC+PKCE, HTTP SSE/ACK, protected APIs, persisted SQLite, native HTTP, media 501')
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        for server in servers:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
