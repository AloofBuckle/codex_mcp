#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "UPSTREAM.json").read_text())
records = manifest["copied_files"] + manifest.get("extracted_files", [])
for record in records:
    actual = hashlib.sha256((root / record["destination"]).read_bytes()).hexdigest()
    if actual != record["sha256"]:
        raise SystemExit("Vendored source differs: " + record["destination"])
print("Verified", len(records), "vendored/extracted files from", manifest["source_commit"])
