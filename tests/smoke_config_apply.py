"""Test the config-draft -> four split backends -> apply -> run lifecycle."""
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
STATE = Path(tempfile.mkdtemp(prefix="agro-config-apply-"))
ENV = os.environ.copy()
ENV["PYTHONPATH"] = os.pathsep.join([str(ROOT / "src"), str(ROOT / "adapters"), ENV.get("PYTHONPATH", "")])
LOG = (STATE / "agent.log").open("w")
PROCESS = subprocess.Popen(
    [sys.executable, "-m", "agro_runtime.cli", "agent", "serve", "--config",
     str(ROOT / "examples/tomato_picker/system.yaml"),
     "--state-dir", str(STATE), "--port", str(PORT)],
    cwd=ROOT, env=ENV, stdout=LOG, stderr=subprocess.STDOUT,
)


def poll(client, uri, done, attempts=100):
    for _ in range(attempts):
        value = client.get(uri).json()
        if done(value):
            return value
        time.sleep(0.2)
    raise AssertionError(f"Wait failed at {uri}: {value}")


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
                if client.get("/config/status").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
        if PROCESS.poll() is not None:
            raise RuntimeError("Agent exited unexpectedly")
        time.sleep(0.2)
    else:
        raise TimeoutError("Agent failed to start")

    status = client.get("/config/status").json()
    draft_resp = client.post("/config/drafts", json={"base_snapshot_id": status["snapshot_id"]})
    draft_resp.raise_for_status()
    draft = draft_resp.json()
    content = draft["content"]
    assert len(content["backends"]) == 1 and content["backends"][0]["package_id"] == "tomato_simulator"
    source = content["backends"][0]
    groups = ("vision", "navigation", "arm", "control")
    content["backends"] = [
        {**source, "instance_id": name,
         "runtime": {"manager": "local_process", "target": f"tomato_simulator.{name}", "health_check": "mock_status"}}
        for name in groups
    ]
    def group(capability):
        prefix = capability.split(".")[0]
        return "vision" if prefix == "perception" else "navigation" if prefix == "navigation" else "arm" if prefix in ("geometry", "manipulation") else "control"
    for binding in content["roles"].values():
        binding["backend_instance"] = group(binding["capability_id"])

    saved_resp = client.put(f"/config/drafts/{draft['id']}", json={"revision": draft["revision"], "content": content})
    saved_resp.raise_for_status()
    assert saved_resp.json()["validation"]["valid"]
    diff_resp = client.get(f"/config/drafts/{draft['id']}/diff")
    diff_resp.raise_for_status()
    diff = diff_resp.json()
    assert diff["validation"]["valid"]
    apply_resp = client.post("/config/apply", json={"draft_id": draft["id"], "revision": diff["revision"], "base_snapshot_id": diff["base_snapshot_id"], "request_id": "apply_" + uuid.uuid4().hex})
    apply_resp.raise_for_status()
    job = poll(client, "/management/jobs/" + apply_resp.json()["management_job_id"], lambda v: v["phase"] in {"completed", "failed", "blocked", "rolled_back"})
    assert job["phase"] == "completed", job
    current = client.get("/config/status").json()
    assert {b["instance_id"] for b in current["content"]["backends"]} == set(groups)
    print("Draft saved, validated and applied; four backend configuration is active")

    client.post("/system/start", json={"request_id": "start_" + uuid.uuid4().hex}).raise_for_status()
    ready = poll(client, "/system/status", lambda v: v["state"] in {"READY", "FAILED", "BLOCKED", "UNKNOWN"})
    assert ready["state"] == "READY", ready
    client.post("/system/stop", json={"request_id": "stop_" + uuid.uuid4().hex}).raise_for_status()
    stopped = poll(client, "/system/status", lambda v: v["state"] == "STOPPED")
    assert stopped["state"] == "STOPPED"
    print("Applied four-backend system starts and stops; PASS")
finally:
    PROCESS.terminate()
    try:
        PROCESS.wait(timeout=5)
    except subprocess.TimeoutExpired:
        PROCESS.kill()
        PROCESS.wait()
    LOG.close()
    print("Agent log:", STATE / "agent.log")
