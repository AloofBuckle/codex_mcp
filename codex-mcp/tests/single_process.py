"""Trace the service and assert only requested commands create child processes."""

import argparse
import hashlib
import json
import re
import tempfile
from pathlib import Path
from integration import Host, png


def forks(text):
    return [
        line
        for line in text.splitlines()
        if re.search(r"\b(clone3?|fork|vfork)\(", line) and "CLONE_THREAD" not in line
    ]


p = argparse.ArgumentParser()
p.add_argument("--binary", type=Path, required=True)
p.add_argument("--strace", type=Path, required=True)
p.add_argument("--report", type=Path, required=True)
args = p.parse_args()
with tempfile.TemporaryDirectory(prefix="mcpx-single-process-") as directory:
    h = Host(args.binary.resolve(), directory, args.strace.resolve())
    trace = Path(directory) / "process.trace"
    try:
        client = h.register()
        tokens = h.authorize(client)
        token = tokens["access_token"]
        h.rpc(
            token,
            "initialize",
            dict(
                protocolVersion="2025-11-25",
                clientInfo=dict(name="trace", version="1"),
                capabilities={},
            ),
        )
        h.rpc(token, "tools/list")
        for i in range(8):
            result = h.tool(
                token,
                "apply_patch",
                dict(
                    input=f"*** Begin Patch\n*** Add File: patch-{i}.txt\n+single process\n*** End Patch"
                ),
            )
            assert not result["isError"], result
        (Path(directory) / "image.png").write_bytes(png(256, 128))
        assert not h.tool(token, "view_image", dict(path="image.png"))["isError"]
        before = trace.read_text()
        assert not forks(before), forks(before)
        execs = [line for line in before.splitlines() if "execve(" in line or "execveat(" in line]
        assert len(execs) == 1, execs
        assert not any("connect(" in line for line in before.splitlines()), (
            "unexpected outbound or local RPC connection"
        )
        # A command shell must be the gateway's direct child, without a Codex helper.
        command = 'printf \'%s %s\\n\' "$$" "$PPID"; sleep 1'
        for tty in [False, True]:
            out = h.tool(token, "exec_command", dict(cmd=command, tty=tty, yield_time_ms=250))[
                "structuredContent"
            ]
            child, parent = map(int, out["output"].split())
            assert parent == h.server_pid, (child, parent, h.server_pid)
            final = h.tool(token, "write_stdin", dict(session_id=out["session_id"]))
            assert final["structuredContent"]["exit_code"] == 0, final
        h.stop()
        full = trace.read_text()
        assert (
            "exec-server" not in full
            and "runtime/codex" not in full
            and "--codex-run-as-apply-patch" not in full
        )
        report = dict(
            single_service_elf=True,
            service_processes=1,
            startup_patch_image_child_processes=0,
            startup_patch_image_execve_count=len(execs),
            internal_rpc_connections=0,
            user_command_parent="mcpx service PID directly",
            patches_tested=8,
            trace_tool="strace",
            trace_bytes=len(full),
            binary_sha256=hashlib.sha256(args.binary.read_bytes()).hexdigest(),
        )
        args.report.write_text(json.dumps(report, indent=2))
        args.report.with_suffix(".trace").write_text(full)
        print(json.dumps(report, indent=2))
    finally:
        h.stop()
