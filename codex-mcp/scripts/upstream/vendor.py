"""Copy current upstream libraries and apply the local Full Access projection."""

from pathlib import Path
import datetime
import hashlib
import json
import re
import shutil
import tomllib
from .full_access import remove_sandbox_parameters, shell_full_access

CRATES = {
    "codex-utils-string": "utils/string",
    "codex-utils-cache": "utils/cache",
    "codex-utils-image": "utils/image",
    "codex-utils-pty": "utils/pty",
    "codex-utils-absolute-path": "utils/absolute-path",
    "codex-utils-path-uri": "utils/path-uri",
    "codex-apply-patch": "apply-patch",
}
MANAGED = [
    "vendor",
    "src/shell_detect.rs",
    "src/unified_exec/head_tail_buffer.rs",
    "src/unified_exec/head_tail_buffer_tests.rs",
    "reference",
    "LICENSE-Codex",
    "NOTICE-Codex",
    "Cargo.toml",
    "Cargo.lock",
    "UPSTREAM.json",
]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return Path(path).read_text(encoding="utf8")


def write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf8", newline="\n")


def rust_function(source, name):
    """Extract one function at file or impl scope, checking its closing indentation.

    The chosen upstream functions have no outdented raw-string content; rejecting
    unmatched layouts is preferable to silently importing a different operation.
    """
    match = re.search(
        r"(?m)^(?P<indent>    |)(?:pub(?:\([^)]*\))? )?(?:async )?fn " + re.escape(name) + r"[<(]",
        source,
    )
    if not match:
        raise ValueError("upstream function missing: " + name)
    ending = re.search(r"(?m)^" + match["indent"] + r"}\s*$", source[match.end() :])
    if not ending:
        raise ValueError("upstream function boundary changed: " + name)
    return source[match.start() : match.end() + ending.end()].rstrip()


def toml_value(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{k} = {toml_value(v)}" for k, v in value.items()) + " }"
    raise ValueError("unsupported upstream TOML value: " + repr(value))


def update_dependencies(product, upstream):
    old = tomllib.loads(read(product / "Cargo.toml"))["workspace"]["dependencies"]
    official = tomllib.loads(read(upstream / "codex-rs/Cargo.toml"))["workspace"]["dependencies"]
    inherited = set()

    def visit(value, key=""):
        if isinstance(value, dict):
            if value.get("workspace") is True:
                inherited.add(key)
            for child_key, child_value in value.items():
                visit(child_value, child_key)

    for name in CRATES:
        manifest = tomllib.loads(read(product / "vendor" / name / "Cargo.toml"))
        for section in ["dependencies", "dev-dependencies", "build-dependencies"]:
            visit(manifest.get(section, {}))
        for target in manifest.get("target", {}).values():
            for section in ["dependencies", "dev-dependencies", "build-dependencies"]:
                visit(target.get(section, {}))
    resolved = dict(old)
    for name in sorted(inherited):
        if name == "mcpx-local-fs" or name in CRATES:
            resolved[name] = {"path": "vendor/" + name}
            continue
        if name not in official:
            raise ValueError("upstream dependency not found: " + name)
        value = official[name]
        if isinstance(value, dict) and ("path" in value or "git" in value):
            raise ValueError("new upstream nonregistry dependency requires an adapter: " + name)
        # Carry the gateway's required features, but source version constraints from upstream.
        options = dict(old[name]) if isinstance(old.get(name), dict) else {}
        if isinstance(value, str):
            options["version"] = value
        else:
            options.update(value)
        for key in ["path", "git", "branch", "rev", "tag"]:
            options.pop(key, None)
        resolved[name] = options["version"] if set(options) == {"version"} else options
    text = read(product / "Cargo.toml")
    block = "[workspace.dependencies]\n" + "".join(
        name + " = " + toml_value(value) + "\n" for name, value in sorted(resolved.items())
    )
    text, count = re.subn(
        r"(?ms)^\[workspace\.dependencies\]\n.*?(?=^\[)", lambda _: block + "\n", text, count=1
    )
    if count != 1:
        raise ValueError("gateway workspace dependency section missing")
    write(product / "Cargo.toml", text)


def project(upstream, product):
    """Project into an isolated candidate, never into a running installation."""
    upstream = Path(upstream)
    product = Path(product)
    mapping = {}

    def copy(source, destination):
        source = Path(source)
        destination = Path(destination)
        if source.is_symlink():
            raise ValueError("upstream symlink requires explicit handling: " + str(source))
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        mapping[destination.relative_to(product).as_posix()] = source.relative_to(
            upstream
        ).as_posix()

    for local, original in CRATES.items():
        target = product / "vendor" / local
        if target.exists():
            shutil.rmtree(target)
        for file in sorted((upstream / "codex-rs" / original).rglob("*")):
            if file.is_file() and not file.name.lower().startswith("readme"):
                copy(file, target / file.relative_to(upstream / "codex-rs" / original))
    patch = product / "vendor/codex-apply-patch"
    for file in (patch / "src").glob("*.rs"):
        # Standalone entrypoints are removed below; remaining algorithms retain upstream behavior.
        if file.name in ["main.rs", "standalone_executable.rs"]:
            continue
        text = read(file).replace("codex_exec_server::", "mcpx_local_fs::")
        write(file, remove_sandbox_parameters(text))
    cargo = read(patch / "Cargo.toml")
    for expected in ["codex-exec-server = { workspace = true }", "license.workspace = true"]:
        if expected not in cargo:
            raise ValueError("upstream patch Cargo layout changed: " + expected)
    cargo = re.sub(r'\[\[bin\]\]\nname = "apply_patch"\npath = "src/main.rs"\n', "", cargo)
    cargo = cargo.replace(
        "license.workspace = true", "license.workspace = true\nautobins = false\nautotests = false"
    )
    cargo = cargo.replace(
        "codex-exec-server = { workspace = true }", "mcpx-local-fs = { workspace = true }"
    )
    for dep in ["codex-utils-cargo-bin", "assert_cmd"]:
        cargo = re.sub(r"(?m)^" + dep + r" = .*\n", "", cargo)
    write(patch / "Cargo.toml", cargo)
    lib = (
        read(patch / "src/lib.rs")
        .replace("mod standalone_executable;\n", "")
        .replace("pub use standalone_executable::main;\n", "")
    )
    write(patch / "src/lib.rs", lib)
    for name in ["main.rs", "standalone_executable.rs"]:
        (patch / "src" / name).unlink()
    pty = product / "vendor/codex-utils-pty/Cargo.toml"
    text = read(pty).replace(
        'winapi = { version = "0.3.9", features = [',
        'winapi = { version = "0.3.9", features = [\n    "std",',
    )
    write(pty, text)

    fs = product / "vendor/mcpx-local-fs"
    if fs.exists():
        shutil.rmtree(fs)
    templates = product / "scripts/upstream/templates"
    shutil.copytree(templates, fs / "template-source")
    shutil.copy2(templates / "fs-Cargo.toml", fs / "Cargo.toml")
    write(fs / "src/lib.rs", read(templates / "fs-lib.rs"))
    shutil.rmtree(fs / "template-source")
    for name in ["no_follow", "regular_file.rs", "regular_file_tests.rs"]:
        source = upstream / "codex-rs/exec-server/src" / name
        if source.is_dir():
            for file in source.rglob("*"):
                if file.is_file():
                    copy(file, fs / "src" / name / file.relative_to(source))
        else:
            copy(source, fs / "src" / name)
    source = read(upstream / "codex-rs/exec-server/src/local_file_system.rs")
    direct = source[source.index("impl DirectFileSystem {") :]
    methods = [
        "open_file_for_read",
        "canonicalize",
        "read_file",
        "write_file",
        "create_directory",
        "get_metadata",
        "remove",
    ]
    body = "\n".join(remove_sandbox_parameters(rust_function(direct, n)) for n in methods)
    helpers = "\n".join(
        rust_function(source, n)
        for n in ["file_too_large_error", "file_metadata", "system_time_to_unix_ms"]
    )
    header = """//! Direct file methods extracted from Codex and compiled into codex-mcp.
use crate::*;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use std::sync::{Arc,LazyLock};
use std::time::{SystemTime,UNIX_EPOCH};
use tokio::{io,io::AsyncReadExt};
const MAX_READ_FILE_BYTES:u64=512*1024*1024;
pub static LOCAL_FS:LazyLock<Arc<dyn ExecutorFileSystem>>=LazyLock::new(||Arc::new(LocalFileSystem));
pub struct LocalFileSystem;
"""
    write(
        fs / "src/local.rs",
        header
        + read(templates / "fs-forward.rs")
        + "\nimpl LocalFileSystem {\n"
        + body
        + "\n}\n"
        + helpers
        + "\n",
    )
    mapping["vendor/mcpx-local-fs/src/local.rs"] = "codex-rs/exec-server/src/local_file_system.rs"
    mapping["vendor/mcpx-local-fs/src/lib.rs"] = "codex-rs/file-system/src/lib.rs"

    copy(upstream / "codex-rs/shell-command/src/shell_detect.rs", product / "src/shell_detect.rs")
    write(product / "src/shell_detect.rs", shell_full_access(read(product / "src/shell_detect.rs")))
    for name in ["head_tail_buffer.rs", "head_tail_buffer_tests.rs"]:
        copy(
            upstream / "codex-rs/core/src/unified_exec" / name, product / "src/unified_exec" / name
        )
    reference = product / "reference"
    if reference.exists():
        shutil.rmtree(reference)
    for name in ["shell_spec.rs", "view_image_spec.rs", "apply_patch_spec.rs"]:
        copy(upstream / "codex-rs/core/src/tools/handlers" / name, reference / name)
    copy(upstream / "codex-rs/core/assets/tools/apply_patch.lark", reference / "apply_patch.lark")
    copy(upstream / "LICENSE", product / "LICENSE-Codex")
    copy(upstream / "NOTICE", product / "NOTICE-Codex")
    update_dependencies(product, upstream)
    return {dest: source for dest, source in mapping.items() if (product / dest).is_file()}


def record(upstream, product, mapping, repository, ref, commit):
    records = [
        dict(
            destination=destination,
            source=source,
            sha256=sha(product / destination),
            source_sha256=sha(upstream / source),
            modified=sha(product / destination) != sha(upstream / source),
        )
        for destination, source in sorted(mapping.items())
    ]
    result = dict(
        source_repository=repository,
        source_ref=ref,
        source_commit=commit,
        resolved_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        integration="Single ELF, in-process Codex libraries; Full Access only",
        adaptations=[
            "Remove sandbox parameters/type from the patch and local filesystem APIs",
            "Remove unused elevated-Windows-sandbox shell fallback",
            "Direct filesystem extraction with local-only interface",
            "No standalone executable entrypoint, core approval engine, policy engine or audit engine",
            "Keep codex-mcp four-tool contract; upstream dependency versions follow workspace constraints",
            "Enable winapi std on Windows",
        ],
        copied_files=records,
    )
    write(product / "UPSTREAM.json", json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result
