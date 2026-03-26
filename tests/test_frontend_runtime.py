import shutil
import subprocess

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node is required for frontend runtime tests")
def test_frontend_runtime_node_suite():
    result = subprocess.run(
        ["node", "--test", "tests/frontend_runtime.test.mjs"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.fail(
            "frontend runtime node tests failed\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
