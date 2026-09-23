#!/usr/bin/env python3
"""Follow configured upstream in an isolated candidate and validate before applying.

This is a build/maintenance command. It never restarts a service, deploys an ELF,
or adds an updater process to the MCP server.
"""

import argparse
import contextlib
import datetime
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from pathlib import Path
from upstream.vendor import MANAGED, project, record, sha, write


def run(command, cwd, log=None):
    if log:
        with log.open("a", encoding="utf8") as output:
            result = subprocess.run(
                command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, text=True
            )
        if result.returncode:
            tail = log.read_text(encoding="utf8", errors="replace")[-7000:]
            raise RuntimeError(f"Validation failed ({command[0]}):\n{tail}")
    else:
        subprocess.run(command, cwd=cwd, check=True)


def git(*args, cwd):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True, encoding="utf8").strip()


def snapshot(root, paths=MANAGED + ["src", "scripts", "tests", "upstream.toml"]):
    found = {}
    for name in paths:
        path = root / name
        if path.is_file():
            found[name] = sha(path)
        elif path.is_dir():
            for file in path.rglob("*"):
                if file.is_file() and "__pycache__" not in file.parts and file.suffix != ".pyc":
                    found[file.relative_to(root).as_posix()] = sha(file)
    return found


def copy_candidate(root, candidate):
    def ignore(path, names):
        return {
            name
            for name in names
            if name
            in {
                "work",
                "target",
                ".git",
                "__pycache__",
                "config.json",
                "credentials.json",
                "VALIDATION.json",
                "ARCHITECTURE.json",
                "ARCHITECTURE.trace",
                "FULL_ACCESS.json",
                "SYNC_REPORT.json",
            }
            or name.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm"))
        }

    shutil.copytree(root, candidate, ignore=ignore)


@contextlib.contextmanager
def exclusive_lock(path):
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise RuntimeError(
            f"Another updater is running, or a stale lock needs inspection: {path}"
        ) from error
    try:
        with os.fdopen(fd, "w", encoding="ascii") as lock_file:
            lock_file.write(str(os.getpid()))
        yield
    finally:
        path.unlink(missing_ok=True)


def install_candidate(root, candidate, baseline, backup_dir, commit):
    if snapshot(root) != baseline:
        raise RuntimeError(
            "Source changed during validation; candidate preserved, original tree not overwritten"
        )
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = backup_dir / f"mcpx-upstream-before-{stamp}.tar.gz"
    # Backup includes exactly the managed build-source paths; never runtime credentials.
    with tarfile.open(backup, "w:gz") as archive:
        for name in MANAGED:
            if (root / name).exists():
                archive.add(root / name, arcname=name)
    rollback = Path(tempfile.mkdtemp(prefix="rollback-", dir=candidate.parent))
    moved = []
    installed = []
    try:
        for name in MANAGED:
            target = root / name
            replacement = candidate / name
            if not replacement.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            old = rollback / name
            old.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target.rename(old)
                moved.append(name)
            installed.append(name)
            if replacement.is_dir():
                shutil.copytree(replacement, target)
            else:
                shutil.copy2(replacement, target)
    except BaseException:
        for name in reversed(installed):
            path = root / name
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        for name in reversed(moved):
            target = root / name
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            (rollback / name).rename(target)
        raise
    shutil.rmtree(rollback)
    return dict(commit=commit, backup=str(backup), backup_sha256=sha(backup))


def validate(candidate, config, logs):
    python = config.get("sdk_python") or sys.executable
    if os.name != "posix" or not Path("/proc").exists():
        raise RuntimeError("Full validation must run on Linux; --check works on any host")
    commands = [
        ["cargo", "check", "-p", "codex-mcp"],
        ["cargo", "fmt", "-p", "codex-mcp", "-p", "mcpx-local-fs", "-p", "codex-apply-patch"],
        [
            "cargo",
            "clippy",
            "--locked",
            "-p",
            "codex-mcp",
            "-p",
            "mcpx-local-fs",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ],
        [python, "scripts/check_full_access.py", "--report", str(logs / "full-access.json")],
        [python, "-m", "unittest", "discover", "-s", "tests", "-p", "test_upstream_sync.py"],
        [python, "scripts/test_libraries.py", "--report", str(logs / "unit-tests.json")],
        ["cargo", "build", "--release", "--locked", "-p", "codex-mcp"],
        [
            python,
            "tests/integration.py",
            "--binary",
            "target/release/codex-mcp",
            "--report",
            str(logs / "integration.json"),
            "--sdk",
        ],
        [python, "tests/cua_resource.py", "--binary", "target/release/codex-mcp"],
        [
            python,
            "tests/full_access.py",
            "--binary",
            "target/release/codex-mcp",
            "--report",
            str(logs / "full-access-behavior.json"),
        ],
    ]
    strace = config.get("strace") or shutil.which("strace")
    if not strace:
        raise RuntimeError(
            "strace is required for single-process validation; set update.strace in upstream.toml"
        )
    commands.append(
        [
            python,
            "tests/single_process.py",
            "--binary",
            "target/release/codex-mcp",
            "--strace",
            strace,
            "--report",
            str(logs / "architecture.json"),
        ]
    )
    for command in commands:
        print("Validate:", " ".join(command[:4]), flush=True)
        run(command, candidate, logs / "validation.log")
    return dict(
        passed=True,
        binary=str(candidate / "target/release/codex-mcp"),
        binary_sha256=sha(candidate / "target/release/codex-mcp"),
        integration=json.loads((logs / "integration.json").read_text()),
        architecture=json.loads((logs / "architecture.json").read_text()),
        full_access=json.loads((logs / "full-access.json").read_text()),
        full_access_behavior=json.loads((logs / "full-access-behavior.json").read_text()),
        unit_suites=json.loads((logs / "unit-tests.json").read_text()),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="Defaults to project upstream.toml")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument(
        "--check",
        action="store_true",
        help="Resolve upstream ref and report without changing sources",
    )
    modes.add_argument(
        "--stage", action="store_true", help="Build and fully test an isolated candidate"
    )
    modes.add_argument(
        "--apply",
        action="store_true",
        help="Fully validate, back up, then update managed build sources",
    )
    parser.add_argument("--ref", help="Override source.ref for this operation")
    parser.add_argument("--sdk-python", help="Python interpreter containing MCP SDK 2.2.0")
    parser.add_argument("--strace", help="Path to strace for architecture validation")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    config_path = args.config or root / "upstream.toml"
    config = tomllib.loads(config_path.read_text(encoding="utf8"))
    source = config["source"]
    settings = config.get("update", {})
    ref = args.ref or source["ref"]
    repo = source["repository"]
    if not ref or ref.startswith("-") or any(c in ref for c in "\r\n\0"):
        raise ValueError("invalid upstream ref")
    if not repo.startswith("https://github.com/") or "\n" in repo:
        raise ValueError("repository must be an HTTPS GitHub URL")
    work = (root / settings.get("work_dir", "work/upstream")).resolve()
    if not work.is_relative_to(root / "work"):
        raise ValueError("work_dir must remain below the project work/ directory")
    work.mkdir(parents=True, exist_ok=True)
    if args.sdk_python:
        settings["sdk_python"] = args.sdk_python
    if args.strace:
        settings["strace"] = args.strace
    with exclusive_lock(work / "sync.lock"):
        cache = work / "git"
        if not cache.exists():
            cache.mkdir()
            run(["git", "init", "--bare"], cache)
            run(["git", "remote", "add", "origin", repo], cache)
        if git("remote", "get-url", "origin", cwd=cache) != repo:
            raise RuntimeError(
                "Cached repository differs from configuration; use a different work_dir"
            )
        run(["git", "fetch", "--depth=1", "origin", ref], cache)
        commit = git("rev-parse", "FETCH_HEAD", cwd=cache)
        previous = json.loads((root / "UPSTREAM.json").read_text(encoding="utf8")).get(
            "source_commit"
        )
        status = dict(
            repository=repo,
            ref=ref,
            resolved_commit=commit,
            installed_commit=previous,
            changed=commit != previous,
        )
        print(json.dumps(status, indent=2), flush=True)
        if args.check:
            return
        baseline = snapshot(root)
        attempt = Path(tempfile.mkdtemp(prefix=commit[:12] + "-", dir=work))
        attempt.chmod(0o755)
        upstream = attempt / "checkout"
        candidate = attempt / "candidate"
        logs = attempt / "logs"
        logs.mkdir()
        report = dict(**status, candidate=str(candidate), applied=False)
        try:
            archive = attempt / "upstream.tar"
            run(["git", "archive", "--format=tar", "--output=" + str(archive), commit], cache)
            upstream.mkdir()
            with tarfile.open(archive, "r:") as source_archive:
                source_archive.extractall(upstream, filter="data")
            archive.unlink()
            copy_candidate(root, candidate)
            mapping = project(upstream, candidate)
            report["validation"] = validate(candidate, settings, logs)
            record(upstream, candidate, mapping, repo, ref, commit)
            run([sys.executable, "scripts/verify_vendor.py"], candidate, logs / "validation.log")
            if args.apply:
                backup_dir = Path(settings.get("backup_dir", "/files/transfer")).expanduser()
                report["installation"] = install_candidate(
                    root, candidate, baseline, backup_dir, commit
                )
                report["applied"] = True
                shutil.copy2(logs / "full-access.json", root / "FULL_ACCESS.json")
            write(attempt / "report.json", json.dumps(report, indent=2) + "\n")
            write(root / "SYNC_REPORT.json", json.dumps(report, indent=2) + "\n")
        except BaseException as error:
            report["error"] = str(error)
            write(attempt / "report.json", json.dumps(report, indent=2) + "\n")
            print(
                f"Candidate failed; live build sources not applied. Report: {attempt / 'report.json'}",
                file=sys.stderr,
            )
            raise
        print("Upstream validation complete. Report:", attempt / "report.json", flush=True)
        print("Service installation and running processes were not changed.", flush=True)


if __name__ == "__main__":
    main()
