#!/usr/bin/env python3
"""Build the unmodified upstream manager as a separate, test-only artifact."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "out/PoolManager.fixture.sol/PoolManager.json"
COMPILER_VERSION = "0.8.26"


def main():
    sources = {}

    def add(name):
        if name in sources:
            return
        path = ROOT / "lib/v4-core" / name
        if name.startswith("solmate/"):
            path = ROOT / "lib" / name
        content = path.read_text()
        sources[name] = {"content": content}
        for imported in re.findall(r'import\s+(?:[^;]*?from\s+)?[\"\']([^\"\']+)[\"\']\s*;', content):
            resolved = os.path.normpath(str(Path(name).parent / imported)) if imported.startswith(".") else imported
            add(resolved)

    add("src/PoolManager.sol")
    request = {
        "language": "Solidity", "sources": sources,
        "settings": {
            "optimizer": {"enabled": True, "runs": 200}, "viaIR": False, "evmVersion": "cancun",
            "outputSelection": {"src/PoolManager.sol": {"PoolManager": ["abi", "evm.bytecode", "evm.deployedBytecode"]}},
        },
    }
    import hashlib
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    if OUT.exists() and json.loads(OUT.read_text()).get("fixtureInputHash") == fingerprint:
        return
    compiler = Path.home() / ".local/share/svm" / COMPILER_VERSION / ("solc-" + COMPILER_VERSION)
    if not compiler.exists():
        # Ask Foundry to install the exact compiler using an isolated empty project.
        with tempfile.TemporaryDirectory(prefix="pool-compiler-") as directory:
            p = Path(directory)
            (p / "src").mkdir()
            (p / "foundry.toml").write_text('[profile.default]\nsolc_version="0.8.26"\n')
            (p / "src/Version.sol").write_text('pragma solidity 0.8.26; contract Version {}')
            subprocess.run([str(Path.home()/'.foundry/bin/forge'), "build", "--root", directory], check=True,
                           stdout=subprocess.DEVNULL)
    result = subprocess.run([str(compiler), "--standard-json"], input=json.dumps(request), capture_output=True, text=True, check=True)
    response = json.loads(result.stdout)
    errors = [e for e in response.get("errors", []) if e["severity"] == "error"]
    if errors:
        raise SystemExit("\n".join(e["formattedMessage"] for e in errors))
    contract = response["contracts"]["src/PoolManager.sol"]["PoolManager"]
    artifact = {
        "abi": contract["abi"], "bytecode": contract["evm"]["bytecode"],
        "deployedBytecode": contract["evm"]["deployedBytecode"],
        "fixtureInputHash": fingerprint, "compiler": COMPILER_VERSION,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(artifact))
    print("Built test-only PoolManager artifact with upstream solc " + COMPILER_VERSION)


if __name__ == "__main__":
    main()
