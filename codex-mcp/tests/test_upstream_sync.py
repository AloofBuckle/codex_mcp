import json
import runpy
import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from sync_upstream import exclusive_lock, install_candidate, snapshot
from upstream.full_access import remove_sandbox_parameters
from upstream.vendor import rust_function, toml_value


class SynchronizationTests(unittest.TestCase):
    def test_removes_context_in_signatures_and_calls(self):
        before = "use mcpx_local_fs::FileSystemSandboxContext;\nfn x(\n    fs: &Fs,\n    sandbox: Option<&'a FileSystemSandboxContext>,\n) { fs.read(path, sandbox); x(fs, /*sandbox*/ None); }\n"
        self.assertEqual(
            remove_sandbox_parameters(before), "fn x(\n    fs: &Fs,\n) { fs.read(path); x(fs); }\n"
        )

    def test_rejects_unknown_context_shape(self):
        with self.assertRaises(ValueError):
            remove_sandbox_parameters("struct NewContext { sandbox: FileSystemSandboxContext }")

    def test_missing_upstream_function_is_not_silently_skipped(self):
        with self.assertRaises(ValueError):
            rust_function("impl F {\n}\n", "read_file")

    def test_workspace_toml_values_preserve_strings_arrays(self):
        import tomllib

        value = {"version": "1", "features": ["full"], "default-features": False}
        self.assertEqual(tomllib.loads("v = " + toml_value(value))["v"], value)

    def test_update_lock_excludes_a_second_sync(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "lock"
            with exclusive_lock(path):
                with self.assertRaises(RuntimeError):
                    with exclusive_lock(path):
                        pass
            self.assertFalse(path.exists())

    def test_concurrent_edit_prevents_application(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "root"
            candidate = Path(temp) / "candidate"
            root.mkdir()
            candidate.mkdir()
            (root / "Cargo.toml").write_text("old")
            (candidate / "Cargo.toml").write_text("new")
            baseline = snapshot(root)
            (root / "Cargo.toml").write_text("user-edit")
            with self.assertRaises(RuntimeError):
                install_candidate(root, candidate, baseline, Path(temp) / "backups", "abc")
            self.assertEqual((root / "Cargo.toml").read_text(), "user-edit")

    def test_partial_copy_rolls_back(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "root"
            candidate = Path(temp) / "candidate"
            root.mkdir()
            candidate.mkdir()
            (root / "vendor").mkdir()
            (root / "vendor/old.rs").write_text("old")
            (candidate / "vendor").mkdir()
            (candidate / "vendor/new.rs").write_text("new")
            baseline = snapshot(root)

            def fail(source, target):
                target.mkdir()
                (target / "incomplete").write_text("partial")
                raise OSError("disk full")

            with patch("sync_upstream.shutil.copytree", side_effect=fail):
                with self.assertRaises(OSError):
                    install_candidate(root, candidate, baseline, Path(temp) / "backups", "abc")
            self.assertEqual(snapshot(root), baseline)
            self.assertEqual(len(list((Path(temp) / "backups").glob("*.tar.gz"))), 1)

    def test_build_follow_mode_installs_only_validated_artifact(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "scripts").mkdir()
            script = root / "scripts/build.py"
            original = Path(__file__).resolve().parent.parent / "scripts/build.py"
            script.write_text(original.read_text(encoding="utf8"), encoding="utf8")
            (root / "upstream.toml").write_text("[build]\nfollow_upstream=true\n")
            artifact = root / "candidate-mcpx"
            artifact.write_bytes(b"validated-build")
            (root / "SYNC_REPORT.json").write_text(
                json.dumps({"validation": {"binary": str(artifact)}})
            )
            with patch("subprocess.run") as run, patch("sys.argv", [str(script)]):
                runpy.run_path(str(script), run_name="__main__")
            self.assertIn("--apply", run.call_args.args[0])
            self.assertEqual((root / "target/release/codex-mcp").read_bytes(), b"validated-build")

    def test_offline_build_does_not_call_updater(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "scripts").mkdir()
            script = root / "scripts/build.py"
            script.write_text(
                (Path(__file__).resolve().parent.parent / "scripts/build.py").read_text(
                    encoding="utf8"
                ),
                encoding="utf8",
            )
            (root / "upstream.toml").write_text("[build]\nfollow_upstream=true\n")
            with patch("subprocess.run") as run, patch("sys.argv", [str(script), "--offline"]):
                runpy.run_path(str(script), run_name="__main__")
            self.assertEqual(
                run.call_args.args[0],
                ["cargo", "build", "--release", "--locked", "-p", "codex-mcp"],
            )


if __name__ == "__main__":
    unittest.main()
