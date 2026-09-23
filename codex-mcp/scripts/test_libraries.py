#!/usr/bin/env python3
"""Build test binaries, then run them without root's DAC override on Linux."""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--report", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
build = subprocess.run(
    [
        "cargo",
        "test",
        "--locked",
        "--workspace",
        "--lib",
        "--bins",
        "--no-run",
        "--message-format=json",
    ],
    cwd=root,
    stdout=subprocess.PIPE,
    text=True,
    check=True,
)
tests = []
for line in build.stdout.splitlines():
    try:
        artifact = json.loads(line)
    except ValueError:
        continue
    if (
        artifact.get("reason") == "compiler-artifact"
        and artifact.get("profile", {}).get("test")
        and artifact.get("executable")
    ):
        tests.append((artifact["target"]["name"], artifact["executable"]))
report = []
with tempfile.TemporaryDirectory(prefix="codex-mcp-tests-", dir="/tmp") as public_tmp:
    os.chmod(public_tmp, 0o755)
    for index, (name, executable) in enumerate(tests):
        command = [executable]
        run_cwd = root
        if os.name == "posix" and os.geteuid() == 0:
            # Official patch tests use permission-denied fixtures; root bypasses them.
            # The build tree can be private under a 077 umask. Some upstream tests
            # re-exec current_exe(), so run a world-executable copy from /tmp rather
            # than weakening permissions on the source/build tree.
            public_executable = Path(public_tmp) / f"{index}-{Path(executable).name}"
            shutil.copy2(executable, public_executable)
            os.chmod(public_executable, 0o755)
            command = [
                "setpriv",
                "--reuid=65534",
                "--regid=65534",
                "--clear-groups",
                str(public_executable),
            ]
            run_cwd = public_tmp
        run = subprocess.run(
            command, cwd=run_cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        print(run.stdout, flush=True)
        run.check_returncode()
        summary = [line for line in run.stdout.splitlines() if line.startswith("test result:")][-1]
        report.append(dict(crate=name, summary=summary))
if args.report:
    args.report.write_text(json.dumps(report, indent=2))
