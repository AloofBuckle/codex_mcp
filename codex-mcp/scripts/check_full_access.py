#!/usr/bin/env python3
"""Verify that the compiled gateway has no approval/policy/audit execution layer."""

import argparse
import json
import re
import subprocess
from pathlib import Path

BLOCKED_PACKAGES = {
    "codex-core",
    "codex-exec-server",
    "codex-execpolicy",
    "codex-sandboxing",
    "codex-guardian",
    "codex-guardian-v2",
    "codex-network-proxy",
    "codex-analytics",
}
BLOCKED_API = re.compile(
    r"\b(?:FileSystemSandboxContext|sandbox_permissions|additional_permissions|approval_policy|approval_request|request_approval|user_confirmed|confirmation_token|AuditStore|AuditEvent|audit_log|guardian)\b",
    re.I,
)


def inspect(root):
    source = list((root / "src").rglob("*.rs"))
    for crate in (root / "vendor").iterdir():
        if (crate / "src").is_dir():
            source.extend((crate / "src").rglob("*.rs"))
    failures = []
    for file in source:
        text = file.read_text(encoding="utf8")
        for line, content in enumerate(text.splitlines(), 1):
            if BLOCKED_API.search(content):
                failures.append(f"{file.relative_to(root)}:{line}: {content.strip()}")
        if file.name == "protocol.rs" and re.search(r"tracing::(?:info|debug|trace)!", text):
            failures.append("Per-request/tool activity logging found in protocol.rs")
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--format-version=1", "--locked"], cwd=root, text=True
        )
    )
    packages = {package["name"] for package in metadata["packages"]}
    blocked = {
        name
        for name in packages
        if any(name == blocked or name.startswith(blocked + "-") for blocked in BLOCKED_PACKAGES)
    }
    if blocked:
        failures.append("Linked blocked policy packages: " + ", ".join(sorted(blocked)))
    if (root / "src/rpc.rs").exists():
        failures.append("Internal RPC adapter exists")
    if failures:
        raise RuntimeError("\n".join(failures))
    return dict(
        full_access_only=True,
        execution_approval_engine=False,
        command_policy=False,
        execution_audit=False,
        sandbox_api=False,
        internal_rpc=False,
        checked_rust_files=len(source),
        kept=[
            "OAuth identity and token authorization",
            "process ownership by OAuth grant",
            "MCP type validation and side-effect metadata",
            "OS filesystem/UID privileges",
            "output/image/HTTP memory limits",
            "lifecycle and error diagnostics",
        ],
        blocked_packages_present=[],
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--report", type=Path)
    a = p.parse_args()
    result = inspect(Path(__file__).resolve().parent.parent)
    if a.report:
        a.report.write_text(json.dumps(result, indent=2), encoding="utf8")
    print(json.dumps(result, indent=2))
