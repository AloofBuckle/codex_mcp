"""Mechanical projection of unused sandbox parameters out of the copied patch API."""

import re


def remove_sandbox_parameters(source):
    source = re.sub(
        r"(?m)^use (?:mcpx_local_fs|codex_exec_server)::FileSystemSandboxContext;\n", "", source
    )
    source = re.sub(
        r"(?m)^\s*sandbox:\s*Option<&(?:\'[a-zA-Z_]\w*\s+)?(?:mcpx_local_fs::)?FileSystemSandboxContext>,?\n",
        "",
        source,
    )
    source = re.sub(r",\s*/\*sandbox\*/\s*None", "", source)
    source = re.sub(r",\s*sandbox\b", "", source)
    # The generated local-only filesystem has no policy context to validate.
    source = source.replace("        reject_sandbox_context(sandbox)?;\n", "")
    source = re.sub(r"\bsandbox\b\s*,\s*", "", source)
    if "FileSystemSandboxContext" in source or re.search(r"\bsandbox\b", source):
        raise ValueError("upstream patch signature changed: sandbox projection needs review")
    return source


def shell_full_access(source):
    start = source.index("// Store PowerShell can be inaccessible")
    end = source.index("fn get_shell_path(", start)
    source = source[:start] + source[end:]
    start = source.index("/// Returns a replacement only when shell_path targets Store PowerShell")
    end = source.index("fn get_cmd_shell(", start)
    source = source[:start] + source[end:]
    start = source.index("    #[test]\n    fn elevated_sandbox_filter_")
    end = source.index("    #[test]\n    fn test_detect_shell_type", start)
    source = source[:start] + source[end:]
    if re.search("sandbox|approval|guardian", source, re.I):
        raise ValueError("unexpected sandbox/approval code in upstream shell detector")
    return source
