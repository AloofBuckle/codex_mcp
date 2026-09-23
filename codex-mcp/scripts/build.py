#!/usr/bin/env python3
"""Build using configured upstream tracking, or use --offline for the validated snapshot."""

import argparse
import json
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--offline", action="store_true")
p.add_argument("--config", type=Path)
p.add_argument("--sdk-python")
p.add_argument("--strace")
a = p.parse_args()
root = Path(__file__).resolve().parent.parent
config_path = a.config or root / "upstream.toml"
config = tomllib.loads(config_path.read_text(encoding="utf8"))
if not a.offline and config.get("build", {}).get("follow_upstream", True):
    command = [
        sys.executable,
        str(root / "scripts/sync_upstream.py"),
        "--config",
        str(config_path),
        "--apply",
    ]
    if a.sdk_python:
        command.extend(["--sdk-python", a.sdk_python])
    if a.strace:
        command.extend(["--strace", a.strace])
    subprocess.run(command, cwd=root, check=True)
    report = json.loads((root / "SYNC_REPORT.json").read_text(encoding="utf8"))
    artifact = Path(report["validation"]["binary"])
    target = root / "target/release/codex-mcp"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name("mcpx.new")
    shutil.copy2(artifact, temporary)
    temporary.replace(target)
    print("Validated upstream build:", target)
else:
    subprocess.run(
        ["cargo", "build", "--release", "--locked", "-p", "codex-mcp"], cwd=root, check=True
    )
    print("Built the recorded, validated source snapshot without upstream fetch.")
