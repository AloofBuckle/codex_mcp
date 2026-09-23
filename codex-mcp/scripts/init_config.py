#!/usr/bin/env python3
"""Initialize an isolated codex-mcp configuration without modifying any system service."""

import argparse
import json
import os
import secrets
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--binary", type=Path, required=True)
p.add_argument("--issuer", required=True, help="Public HTTPS origin, without /mcp")
p.add_argument("--state-dir", type=Path, required=True)
p.add_argument("--workdir", type=Path, required=True)
p.add_argument(
    "--permanent-access-token",
    action="store_true",
    help="Also disable access-token expiry; refresh grants are always persistent",
)
a = p.parse_args()
os.umask(0o077)
state = a.state_dir.resolve()
state.mkdir(parents=True, exist_ok=True)
config = state / "config.json"
password_file = state / "authorization-password.txt"
if config.exists() or password_file.exists():
    raise SystemExit("Refusing to overwrite existing configuration or credentials")
password = secrets.token_urlsafe(32)
hashed = (
    subprocess.check_output([str(a.binary.resolve()), "hash-password"], input=password.encode())
    .decode()
    .strip()
)
config.write_text(
    json.dumps(
        dict(
            issuer=a.issuer.rstrip("/"),
            password_hash=hashed,
            database=str(state / "oauth.sqlite"),
            workdir=str(a.workdir.resolve()),
            expose_shell=True,
            login=True,
            access_ttl_seconds=0 if a.permanent_access_token else 3600,
            max_sessions=64,
        ),
        indent=2,
    )
)
password_file.write_text(password + "\n")
print("Configuration:", config)
print("Authorization password stored in:", password_file)
print("No services or reverse proxies were changed.")
