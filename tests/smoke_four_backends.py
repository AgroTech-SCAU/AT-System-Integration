"""Self-contained API smoke check using a clean temp state; never starts real devices."""
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    PORT = sock.getsockname()[1]
STATE = Path(tempfile.mkdtemp(prefix="agro-four-mock-"))
ENV = os.environ.copy()
ENV["PYTHONPATH"] = os.pathsep.join([str(ROOT / "src"), str(ROOT / "adapters"), ENV.get("PYTHONPATH", "")])
LOG = (STATE / "agent.log").open("w")
PROCESS = subprocess.Popen(
    [sys.executable, "-m", "agro_runtime.cli", "agent", "serve", "--config",
     str(ROOT / "examples/tomato_picker/system_four_backends.yaml"),
     "--state-dir", str(STATE), "--port", str(PORT)],
    cwd=ROOT, env=ENV, stdout=LOG, stderr=subprocess.STDOUT,
)


def wait_for_status(client, expected, attempts=120):
    for _ in range(attempts):
        status = client.get("/system/status").json()
        if status["state"] == expected:
            return status
        if status["state"] in {"BLOCKED", "FAILED", "UNKNOWN"}:
            raise AssertionError(status)
        time.sleep(0.2)
    raise AssertionError(f"Timeout waiting for {expected}: {status}")


try:
    client = None
    for _ in range(100):
        token_file = STATE / "session.token"
        if token_file.exists():
            client = httpx.Client(
                base_url=f"http://127.0.0.1:{PORT}",
                headers={"Authorization": "Bearer " + token_file.read_text().strip()}, timeout=4,
            )
            try:
                if client.get("/system/status").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
        if PROCESS.poll() is not None:
            raise RuntimeError("Agent exited unexpectedly")
        time.sleep(0.2)
    else:
        raise TimeoutError("Agent failed to start")

    client.post("/system/start", json={"request_id": "start_" + uuid.uuid4().hex}).raise_for_status()
    ready = wait_for_status(client, "READY")
    assert set(ready["modules"]) == {"vision", "navigation", "arm", "control"}
    assert all(mod["process"] and mod["interface"] for mod in ready["modules"].values())
    diag = client.get("/diagnostics")
    diag.raise_for_status()
    print("Four backend modules READY; capabilities:", len(diag.json().get("capabilities", [])))

    client.post("/system/stop", json={"request_id": "stop_" + uuid.uuid4().hex}).raise_for_status()
    stopped = wait_for_status(client, "STOPPED")
    assert all(not mod["process"] for mod in stopped["modules"].values())
    print("Four backend modules STOPPED; PASS")
finally:
    PROCESS.terminate()
    try:
        PROCESS.wait(timeout=5)
    except subprocess.TimeoutExpired:
        PROCESS.kill()
        PROCESS.wait()
    LOG.close()
    print("Agent log:", STATE / "agent.log")
