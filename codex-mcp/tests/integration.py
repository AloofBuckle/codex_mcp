"""Black-box tests against real Rust codex-mcp and the official Codex executable.
No OpenAI inference, API keys, production service, or production credentials are used.
"""

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import re
import secrets
import signal
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Host:
    def __init__(self, binary, directory, trace=None):
        self.binary, self.directory = str(binary), Path(directory)
        self.trace = trace
        self.password = secrets.token_urlsafe(24)
        self.config = dict(
            issuer="https://mcpx.test",
            password_hash=subprocess.check_output(
                [self.binary, "hash-password"], input=self.password.encode()
            )
            .decode()
            .strip(),
            database=str(self.directory / "auth.sqlite"),
            workdir=str(self.directory),
            access_ttl_seconds=0,
            expose_shell=True,
            login=False,
        )
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.p = None
        self.start()

    def start(self):
        (self.directory / "config.json").write_text(json.dumps(self.config))
        self.log = open(self.directory / "server.log", "ab")
        command = [self.binary, str(self.directory / "config.json"), f"127.0.0.1:{self.port}"]
        if self.trace:
            command = [
                str(self.trace),
                "-f",
                "-s",
                "512",
                "-e",
                "trace=process,connect",
                "-o",
                str(self.directory / "process.trace"),
            ] + command
        self.p = subprocess.Popen(command, stdout=self.log, stderr=self.log, start_new_session=True)
        for _ in range(200):
            try:
                if self.request("/mcp/health")[0] == 200:
                    self.server_pid = self.p.pid
                    if self.trace:
                        children = (
                            Path(f"/proc/{self.p.pid}/task/{self.p.pid}/children")
                            .read_text()
                            .split()
                        )
                        assert len(children) == 1, children
                        self.server_pid = int(children[0])
                    return
            except (OSError, urllib.error.URLError):
                pass
            if self.p.poll() is not None:
                break
            time.sleep(0.05)
        raise RuntimeError(
            "server startup failed: " + (self.directory / "server.log").read_text()[-5000:]
        )

    def stop(self):
        if self.p and self.p.poll() is None:
            os.kill(self.server_pid, signal.SIGTERM)
            try:
                self.p.wait(timeout=12)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait()
                raise
        self.log.close()

    def request(self, path, data=None, form=None, headers=None, method=None):
        headers = dict(headers or {})
        if data is not None:
            data = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            r = self.opener.open(req, timeout=40)
        except urllib.error.HTTPError as error:
            r = error
        body = r.read()
        status = r.code
        h = dict(r.headers)
        try:
            body = json.loads(body)
        except ValueError:
            body = body.decode()
        return status, h, body

    def register(self, method="none"):
        r = self.request(
            "/mcp/oauth/register",
            data=dict(
                redirect_uris=["http://127.0.0.1:43210/callback"], token_endpoint_auth_method=method
            ),
        )
        assert r[0] == 201, r
        return r[2]

    def client_auth(self, client):
        fields = dict(client_id=client["client_id"])
        headers = {}
        if client["token_endpoint_auth_method"] == "client_secret_post":
            fields["client_secret"] = client["client_secret"]
        elif client["token_endpoint_auth_method"] == "client_secret_basic":
            value = (
                urllib.parse.quote(client["client_id"], safe="")
                + ":"
                + urllib.parse.quote(client["client_secret"], safe="")
            )
            headers["Authorization"] = "Basic " + base64.b64encode(value.encode()).decode()
        return fields, headers

    def code(self, client, resource=None):
        resource = resource or self.config["issuer"] + "/mcp"
        verifier = secrets.token_urlsafe(48)
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        fields = dict(
            client_id=client["client_id"],
            redirect_uri=client["redirect_uris"][0],
            response_type="code",
            code_challenge=challenge,
            code_challenge_method="S256",
            state="state with + &= 中文",
            resource=resource,
            scope="mcp offline_access",
        )
        status, headers, _ = self.request(
            "/mcp/oauth/authorize?"
            + urllib.parse.urlencode(dict(fields, resource="https://wrong.test/mcp"))
        )
        assert status == 303 and urllib.parse.parse_qs(
            urllib.parse.urlsplit(headers["location"]).query
        )["iss"] == [self.config["issuer"]]
        status, h, body = self.request("/mcp/oauth/authorize?" + urllib.parse.urlencode(fields))
        assert status == 200, (status, body)
        request_id = re.search("name=request_id value='([^']+)'", body).group(1)
        cookie = h["set-cookie"].split(";")[0]
        form = dict(request_id=request_id, password=self.password)
        assert self.request("/mcp/oauth/authorize", form=form)[0] == 400
        assert (
            self.request(
                "/mcp/oauth/authorize",
                form=dict(form, password="wrong"),
                headers={"Cookie": cookie},
            )[0]
            == 401
        )
        status, h, _ = self.request("/mcp/oauth/authorize", form=form, headers={"Cookie": cookie})
        assert status == 303, (status, h)
        result = urllib.parse.parse_qs(urllib.parse.urlsplit(h["location"]).query)
        assert result["state"] == [fields["state"]] and result["iss"] == [self.config["issuer"]]
        return result["code"][0], verifier

    def exchange(self, client, code, verifier, resource=None, **extra):
        resource = resource or self.config["issuer"] + "/mcp"
        fields, headers = self.client_auth(client)
        fields.update(
            grant_type="authorization_code",
            code=code,
            redirect_uri=client["redirect_uris"][0],
            code_verifier=verifier,
            resource=resource,
        )
        fields.update(extra)
        return self.request("/mcp/oauth/token", form=fields, headers=headers)

    def authorize(self, client, resource=None):
        resource = resource or self.config["issuer"] + "/mcp"
        code, verifier = self.code(client, resource=resource)
        assert self.exchange(client, code, "a" * 43, resource=resource)[0] == 400
        status, _, tokens = self.exchange(client, code, verifier, resource=resource)
        assert status == 200, (status, tokens)
        assert self.exchange(client, code, verifier, resource=resource)[0] == 400
        return tokens

    def refresh(self, client, token, resource=None, **extra):
        resource = resource or self.config["issuer"] + "/mcp"
        fields, headers = self.client_auth(client)
        fields.update(grant_type="refresh_token", refresh_token=token, resource=resource)
        fields.update(extra)
        return self.request("/mcp/oauth/token", form=fields, headers=headers)

    def rpc(self, token, method, params=None, id=1, path="/mcp"):
        r = self.request(
            path,
            data=dict(jsonrpc="2.0", id=id, method=method, params=params or {}),
            headers={
                "Authorization": "Bearer " + token,
                "Accept": "application/json, text/event-stream",
            },
        )
        assert r[0] == 200, r
        return r[2]

    def tool(self, token, name, args):
        r = self.rpc(token, "tools/call", dict(name=name, arguments=args))
        assert "result" in r, r
        return r["result"]


def png(width, height):
    def chunk(name, data):
        return (
            struct.pack("!I", len(data))
            + name
            + data
            + struct.pack("!I", zlib.crc32(name + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress((b"\x00" + b"\x60\x90\xc0" * width) * height))
        + chunk(b"IEND", b"")
    )


def run(host, sdk=False):
    report = []

    def passed(name):
        report.append(name)
        print("PASS", name, flush=True)

    r = host.request("/mcp", data=dict(jsonrpc="2.0", id=1, method="tools/list"))
    assert r[0] == 401 and "resource_metadata=" in r[1]["www-authenticate"]
    assert (
        host.request("/.well-known/oauth-protected-resource/mcp")[2]["resource"]
        == "https://mcpx.test/mcp"
    )
    metadata = host.request("/.well-known/oauth-authorization-server")[2]
    assert "S256" in metadata["code_challenge_methods_supported"] and not metadata.get(
        "client_id_metadata_document_supported", False
    )
    assert host.request("/mcp/health", headers={"Origin": "https://evil.test"})[0] == 403
    assert (
        host.request("/mcp/oauth/register", data={"redirect_uris": ["javascript:alert(1)"]})[0]
        == 400
    )
    passed("OAuth discovery, origin rejection and redirect validation")
    clients = {
        method: host.register(method)
        for method in ["none", "client_secret_basic", "client_secret_post"]
    }
    tokens = {method: host.authorize(client) for method, client in clients.items()}
    for t in tokens.values():
        assert "expires_in" not in t
    principal = tokens["none"]
    access = principal["access_token"]
    assert (
        host.request(
            "/mcp",
            data={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            headers={"Authorization": "Bearer " + principal["refresh_token"]},
        )[0]
        == 401
    )
    assert host.refresh(clients["none"], tokens["client_secret_post"]["refresh_token"])[0] == 400
    assert (
        host.refresh(clients["none"], principal["refresh_token"], resource="https://evil.test/mcp")[
            0
        ]
        == 400
    )
    passed("PKCE, CSRF, code replay, all client authentication methods and token type isolation")
    init = host.rpc(
        access,
        "initialize",
        {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1"},
        },
    )["result"]
    assert init["protocolVersion"] == "2025-11-25"
    tools = host.rpc(access, "tools/list")["result"]["tools"]
    assert {t["name"] for t in tools} == {
        "exec_command",
        "write_stdin",
        "apply_patch",
        "view_image",
    }
    assert all(t["_meta"]["mcpx/namespace"] == "functions" for t in tools)
    assert host.rpc(access, "unsupported")["error"]["code"] == -32601
    assert host.tool(access, "exec_command", {"command": "false"})["isError"]
    assert host.tool(
        access, "exec_command", {"cmd": "echo hi", "sandbox_permissions": "require_escalated"}
    )["isError"]
    assert (
        host.request("/mcp", method="GET", headers={"Authorization": "Bearer " + access})[0] == 405
    )
    assert (
        host.request(
            "/mcp",
            data={"jsonrpc": "2.0", "method": "notifications/initialized"},
            headers={"Authorization": "Bearer " + access},
        )[0]
        == 202
    )
    passed("MCP initialize, four-tool schema, notifications and protocol errors")
    out = host.tool(access, "exec_command", {"cmd": "printf 'stdout'; printf 'stderr' >&2; exit 7"})
    assert not out["isError"], out
    out = out["structuredContent"]
    assert (
        out["exit_code"] == 7
        and "session_id" not in out
        and "stdout" in out["output"]
        and "stderr" in out["output"]
    ), out
    (host.directory / "subdir").mkdir()
    out = host.tool(
        access,
        "exec_command",
        {"cmd": "pwd", "workdir": "subdir", "shell": "/bin/sh", "login": False},
    )["structuredContent"]
    assert str(host.directory / "subdir") in out["output"], out
    passed("Real Codex pipe execution, exit status, shell selection and relative cwd")
    out = host.tool(
        access,
        "exec_command",
        {"cmd": "printf 'first'; sleep 0.4; printf 'second'", "yield_time_ms": 250},
    )["structuredContent"]
    assert "session_id" in out and "first" in out["output"], out
    sid = out["session_id"]
    denied = host.tool(
        tokens["client_secret_post"]["access_token"], "write_stdin", {"session_id": sid}
    )
    assert denied["isError"], denied
    later = host.tool(access, "write_stdin", {"session_id": sid})["structuredContent"]
    assert later["exit_code"] == 0 and later["output"] == "second", later
    assert host.tool(access, "write_stdin", {"session_id": sid})["isError"]
    passed("Background sessions, exclusive replay cursor, completion and OAuth owner isolation")
    out = host.tool(
        access,
        "exec_command",
        {"cmd": "printf 'early'; sleep 0.5; printf 'late-final'", "yield_time_ms": 250},
    )["structuredContent"]
    delayed_sid = out["session_id"]
    assert out["output"] == "early", out
    print("WAIT delayed poll past Codex executor retention (35 seconds)", flush=True)
    time.sleep(35)
    later = host.tool(access, "write_stdin", {"session_id": delayed_sid})
    assert not later["isError"], later
    later = later["structuredContent"]
    assert later["output"] == "late-final" and later["exit_code"] == 0, later
    passed("Uncollected final output survives the upstream executor exit-retention window")
    out = host.tool(
        access,
        "exec_command",
        {"cmd": "read -r line; printf 'got:%s' \"$line\"", "tty": True, "yield_time_ms": 250},
    )["structuredContent"]
    sid = out["session_id"]
    res = host.tool(
        access, "write_stdin", {"session_id": sid, "chars": "hello\n", "yield_time_ms": 1000}
    )["structuredContent"]
    assert "got:hello" in res["output"] and res["exit_code"] == 0, res
    out = host.tool(access, "exec_command", {"cmd": "sleep 30", "tty": True, "yield_time_ms": 250})[
        "structuredContent"
    ]
    res = host.tool(
        access,
        "write_stdin",
        {"session_id": out["session_id"], "chars": "\x03", "yield_time_ms": 2000},
    )["structuredContent"]
    assert "exit_code" in res and "session_id" not in res, res
    passed("Real Codex PTY stdin and Ctrl-C")
    before = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        calls = list(
            pool.map(
                lambda _: host.tool(access, "exec_command", {"cmd": "sleep 1; printf parallel"}),
                range(2),
            )
        )
    assert time.monotonic() - before < 1.9 and all(
        "parallel" in c["structuredContent"]["output"] for c in calls
    ), calls
    out = host.tool(
        access,
        "exec_command",
        {"cmd": "python3 -c \"print('汉字😀'*10000)\"", "max_output_tokens": 100},
    )["structuredContent"]
    assert out["original_token_count"] > 100 and len(out["output"].encode()) < 700, out
    passed("Concurrent commands and official Unicode token truncation")
    out = host.tool(
        access,
        "exec_command",
        {
            "cmd": "python3 -u -c \"import time; print('BEGIN'); [(print('x'*10000),time.sleep(.002)) for _ in range(200)]; print('END')\"",
            "yield_time_ms": 250,
            "max_output_tokens": 1000,
        },
    )["structuredContent"]
    assert "session_id" in out and out["wall_time_seconds"] < 1, out
    time.sleep(0.7)
    final = host.tool(
        access, "write_stdin", {"session_id": out["session_id"], "max_output_tokens": 1000}
    )["structuredContent"]
    assert "END" in final["output"] and final["exit_code"] == 0, final
    passed("Continuous output yields on time and retains bounded head/tail output")
    target = host.directory / "patch.txt"
    patch = f"*** Begin Patch\n*** Add File: {target}\n+before\n*** End Patch"
    result = host.tool(access, "apply_patch", {"input": patch})
    assert not result["isError"], result
    assert target.read_text() == "before\n"
    patch = f"*** Begin Patch\n*** Update File: {target}\n@@\n-before\n+after\n*** End Patch"
    assert not host.tool(access, "apply_patch", {"input": patch})["isError"]
    assert target.read_text() == "after\n"
    large = host.directory / "large.txt"
    patch = f"*** Begin Patch\n*** Add File: {large}\n" + "+payload\n" * 30000 + "*** End Patch"
    assert not host.tool(access, "apply_patch", {"input": patch})["isError"]
    assert large.stat().st_size == 240000
    assert host.tool(access, "apply_patch", {"input": "invalid"})["isError"]
    assert not host.tool(
        access,
        "apply_patch",
        {"input": f"*** Begin Patch\n*** Delete File: {target}\n*** End Patch"},
    )["isError"]
    assert not target.exists()
    passed("Official apply_patch add/update/delete, invalid patch and large stdin payload")
    image = host.directory / "image.png"
    image.write_bytes(png(3000, 2000))
    high = host.tool(access, "view_image", {"path": "image.png"})
    assert (
        high["content"][0]["type"] == "image" and high["content"][0]["mimeType"] == "image/png"
    ), high
    w, h = struct.unpack("!II", base64.b64decode(high["content"][0]["data"])[16:24])
    assert w <= 2048 and h <= 2048
    original = host.tool(access, "view_image", {"path": "image.png", "detail": "original"})
    assert base64.b64decode(original["content"][0]["data"]) == image.read_bytes()
    assert host.tool(access, "view_image", {"path": "large.txt"})["isError"]
    assert host.tool(access, "view_image", {"path": "."})["isError"]
    passed("Official image processing, resizing, original bytes and MCP image content")
    out = host.tool(
        access, "exec_command", {"cmd": "sleep 2; printf refreshed", "yield_time_ms": 250}
    )["structuredContent"]
    sid = out["session_id"]
    status, _, rotated = host.refresh(clients["none"], principal["refresh_token"])
    assert status == 200, rotated
    assert host.refresh(clients["none"], principal["refresh_token"])[0] == 400
    access = rotated["access_token"]
    later = host.tool(access, "write_stdin", {"session_id": sid})["structuredContent"]
    assert later["output"] == "refreshed", later
    host.stop()
    host.start()
    assert len(host.rpc(access, "tools/list")["result"]["tools"]) == 4
    status, _, rotated = host.refresh(clients["none"], rotated["refresh_token"])
    assert status == 200
    access = rotated["access_token"]
    passed("Refresh rotation retains session ownership; credentials and DCR survive restart")
    if sdk:
        import asyncio

        async def check_sdk():
            import httpx2 as httpx
            from mcp import ClientSession
            from mcp.client.streamable_http import streamable_http_client

            async with httpx.AsyncClient(
                headers={"Authorization": "Bearer " + access}, trust_env=False
            ) as http:
                async with streamable_http_client(host.base + "/mcp", http_client=http) as (
                    read,
                    write,
                ):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.list_tools()
                        assert len(result.tools) == 4
                        result = await session.call_tool("exec_command", {"cmd": "printf sdk_ok"})
                        assert not result.is_error
                        result = await session.call_tool("view_image", {"path": "image.png"})
                        assert result.content[0].type == "image"

        asyncio.run(check_sdk())
        passed("Official MCP Python SDK Streamable HTTP initialize/list/call/image")
    fields, headers = host.client_auth(clients["none"])
    fields["token"] = rotated["refresh_token"]
    assert host.request("/mcp/oauth/revoke", form=fields, headers=headers)[0] == 200
    assert (
        host.request(
            "/mcp",
            data=dict(jsonrpc="2.0", id=1, method="ping"),
            headers={"Authorization": "Bearer " + access},
        )[0]
        == 401
    )
    host.stop()
    host.config["access_ttl_seconds"] = 1
    host.start()
    short = host.authorize(clients["client_secret_basic"])
    assert short["expires_in"] == 1
    time.sleep(1.1)
    assert (
        host.request(
            "/mcp",
            data=dict(jsonrpc="2.0", id=1, method="ping"),
            headers={"Authorization": "Bearer " + short["access_token"]},
        )[0]
        == 401
    )
    assert host.refresh(clients["client_secret_basic"], short["refresh_token"])[0] == 200
    passed("Persistent grant revocation, access expiry and indefinite refresh grant")
    code, verifier = host.code(clients["client_secret_basic"])
    subprocess.run(
        [host.binary, str(host.directory / "config.json"), "revoke-all"],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    assert host.exchange(clients["client_secret_basic"], code, verifier)[0] == 400
    passed("Administrative revocation invalidates issued authorization codes")
    host.stop()
    host.config["access_ttl_seconds"] = 0
    host.config["expose_shell"] = False
    host.start()
    tokens = host.authorize(clients["client_secret_basic"])
    access = tokens["access_token"]
    tools = host.rpc(access, "tools/list")["result"]["tools"]
    spec = next(t for t in tools if t["name"] == "exec_command")
    assert "shell" not in spec["inputSchema"]["properties"]
    assert host.tool(access, "exec_command", {"cmd": "true", "shell": "/bin/bash"})["isError"]
    out = host.tool(access, "exec_command", {"cmd": "cat; printf eof"})["structuredContent"]
    assert out["output"] == "eof", out
    children = []
    for tty in [False, True]:
        out = host.tool(
            access,
            "exec_command",
            {
                "cmd": 'sleep 120 & child=$!; printf "%s %s\\n" "$$" "$child"; wait',
                "tty": tty,
                "yield_time_ms": 250,
            },
        )["structuredContent"]
        assert "session_id" in out, out
        children.extend(int(value) for value in out["output"].split())
    host.stop()

    def running(pid):
        try:
            return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].strip().split()[0] != "Z"
        except FileNotFoundError:
            return False

    deadline = time.monotonic() + 5
    while any(running(pid) for pid in children) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not any(running(pid) for pid in children), children
    passed("Configured shell visibility, non-PTY EOF and shutdown of shell process groups")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--sdk", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(
        prefix="mcpx-integration-", dir=Path(__file__).resolve().parent
    ) as directory:
        host = Host(args.binary.resolve(), directory)
        try:
            report = run(host, args.sdk)
        finally:
            host.stop()
    if args.report:
        args.report.write_text(
            json.dumps(dict(passed=report, count=len(report)), ensure_ascii=False, indent=2)
        )
    print(f"PASS {len(report)} integration groups")
