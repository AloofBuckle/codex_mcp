"""Behavioral verification: unrestricted workspace paths, shell syntax and networking."""

import argparse
import http.server
import json
import sqlite3
import tempfile
import threading
from pathlib import Path
from integration import Host

p = argparse.ArgumentParser()
p.add_argument("--binary", type=Path, required=True)
p.add_argument("--report", type=Path, required=True)
a = p.parse_args()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"network-allowed")

    def log_message(self, *args):
        pass


with tempfile.TemporaryDirectory(prefix="mcpx-full-access-") as temp:
    base = Path(temp)
    cwd = base / "cwd"
    cwd.mkdir()
    outside = base / "outside"
    outside.mkdir()
    h = Host(a.binary.resolve(), cwd)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = h.register()
        token = h.authorize(client)["access_token"]
        path = outside / "patch.txt"
        result = h.tool(
            token,
            "apply_patch",
            {
                "input": f"*** Begin Patch\n*** Add File: {path}\n+outside configured cwd\n*** End Patch"
            },
        )
        assert not result["isError"], result
        assert path.read_text() == "outside configured cwd\n"
        command = """value=$(printf 'full-access')
printf '%s' "$value" | tr a-z A-Z > ../outside/shell.txt
python3 - <<'PY'
from pathlib import Path
import urllib.request
assert Path('../outside/patch.txt').read_text() == 'outside configured cwd\\n'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
print(opener.open('http://127.0.0.1:PORT/').read().decode())
PY
mv ../outside/shell.txt ../outside/moved.txt
cat ../outside/moved.txt
rm ../outside/moved.txt
""".replace("PORT", str(server.server_port))
        result = h.tool(token, "exec_command", {"cmd": command})
        assert not result["isError"], result
        output = result["structuredContent"]
        assert (
            output["exit_code"] == 0
            and "network-allowed" in output["output"]
            and "FULL-ACCESS" in output["output"]
        ), output
        assert not (outside / "moved.txt").exists()
        db = sqlite3.connect(cwd / "auth.sqlite")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        db.close()
        assert tables == {"oauth_clients", "oauth_codes", "oauth_tokens"}, tables
        h.stop()
        log = (cwd / "server.log").read_text()
        assert (
            "HTTP request" not in log
            and "tool completed" not in log
            and "network-allowed" not in log
            and command not in log
        ), log
        report = dict(
            full_access_only=True,
            outside_cwd_write=True,
            pipe_redirection_substitution_heredoc=True,
            command_move_delete=True,
            network=True,
            server_approval_round_trips=0,
            command_audit_records=0,
            database_tables=sorted(tables),
            oauth_required=True,
        )
        a.report.write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        h.stop()
