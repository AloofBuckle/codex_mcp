"""Black-box test for the second `/cua` MCP resource and OAuth isolation."""

import argparse
import json
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from integration import Host


class Backend(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def auth(self):
        return self.headers.get("Authorization") == "Bearer " + self.server.token

    def send_json(self, status, value, extra=None):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.auth():
            return self.send_json(401, {"error": "unauthorized"})
        if self.path != "/mcp":
            return self.send_json(404, {"error": "not_found"})
        self.send_json(
            400,
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": "session required"},
            },
        )

    def do_DELETE(self):
        if not self.auth():
            return self.send_json(401, {"error": "unauthorized"})
        self.send_json(200, {"ok": True})

    def do_POST(self):
        if not self.auth():
            return self.send_json(401, {"error": "unauthorized"})
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        method = body.get("method")
        rid = body.get("id")
        if method == "initialize":
            result = {
                "protocolVersion": "2025-11-25",
                "serverInfo": {"name": "cua_repl", "version": "test"},
                "capabilities": {"tools": {"listChanged": False}},
            }
            return self.send_json(
                200,
                {"jsonrpc": "2.0", "id": rid, "result": result},
                {"Mcp-Session-Id": "cua-test-session"},
            )
        if method == "tools/list":
            tools = [
                {"name": n, "inputSchema": {"type": "object"}}
                for n in ["js", "js_reset", "turn_ended"]
            ]
            return self.send_json(200, {"jsonrpc": "2.0", "id": rid, "result": {"tools": tools}})
        if method == "ping":
            return self.send_json(200, {"jsonrpc": "2.0", "id": rid, "result": {}})
        return self.send_json(
            200,
            {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "Method not found"}},
        )


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run(binary):
    backend_port = free_port()
    token = "internal-cua-test-token-" + "x" * 32
    server = ThreadingHTTPServer(("127.0.0.1", backend_port), Backend)
    server.token = token
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="cua-resource-") as directory:
            directory = Path(directory)
            token_file = directory / "cua-token"
            token_file.write_text(token)
            token_file.chmod(0o600)
            host = Host(binary, directory)
            try:
                host.stop()
                host.config["cua"] = {
                    "upstream": f"http://127.0.0.1:{backend_port}/mcp",
                    "token_file": str(token_file),
                }
                host.start()
                meta = host.request("/.well-known/oauth-protected-resource/cua")[2]
                assert meta["resource"] == "https://mcpx.test/cua", meta
                client = host.register()
                cua = host.authorize(client, resource="https://mcpx.test/cua")
                access = cua["access_token"]
                denied = host.request(
                    "/mcp",
                    data={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                    headers={"Authorization": "Bearer " + access},
                )
                assert denied[0] == 401, denied
                init = host.rpc(
                    access, "initialize", {"protocolVersion": "2025-11-25"}, path="/cua"
                )["result"]
                assert init["serverInfo"]["name"] == "cua_repl", init
                tools = host.rpc(access, "tools/list", path="/cua")["result"]["tools"]
                assert {t["name"] for t in tools} == {"js", "js_reset", "turn_ended"}, tools
                codex = host.authorize(client)
                denied = host.request(
                    "/cua",
                    data={"jsonrpc": "2.0", "id": 1, "method": "ping"},
                    headers={"Authorization": "Bearer " + codex["access_token"]},
                )
                assert denied[0] == 401, denied
                print("PASS cua resource OAuth isolation and MCP proxy")
            finally:
                host.stop()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--binary", required=True, type=Path)
    a = p.parse_args()
    run(a.binary.resolve())
