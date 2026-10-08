"""全新状态：创建空白系统、复制番茄示例、停止态切换、重新读取"""

import os, socket, subprocess, sys, tempfile, time, uuid
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parents[1]
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
state = Path(tempfile.mkdtemp(prefix="agro-library-"))
env = {
    **os.environ,
    "PYTHONPATH": os.pathsep.join(
        [str(ROOT / "src"), str(ROOT / "adapters"), os.environ.get("PYTHONPATH", "")]
    ),
}
log = (state / "agent.log").open("w")
process = subprocess.Popen(
    [
        sys.executable,
        "-m",
        "agro_runtime.cli",
        "agent",
        "serve",
        "--config",
        str(ROOT / "examples/workspace/system.yaml"),
        "--state-dir",
        str(state),
        "--port",
        str(port),
    ],
    cwd=ROOT,
    env=env,
    stdout=log,
    stderr=subprocess.STDOUT,
)
try:
    for i in range(80):
        token = state / "session.token"
        if token.exists():
            client = httpx.Client(
                base_url=f"http://127.0.0.1:{port}",
                headers={"Authorization": "Bearer " + token.read_text().strip()},
                timeout=5,
            )
            try:
                if client.get("/robot-systems").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
        if process.poll() is not None:
            raise RuntimeError(
                "Agent exited; " + (state / "agent.log").read_text()[-2000:]
            )
        time.sleep(0.15)
    else:
        raise RuntimeError("Agent unavailable")

    def get(path):
        r = client.get(path)
        r.raise_for_status()
        return r.json()

    def post(path, data):
        r = client.post(path, json=data)
        if r.status_code >= 400:
            print("HTTP-ERROR", path, r.status_code, r.text)
        r.raise_for_status()
        return r.json()

    assert get("/robot-systems")["systems"] == []
    assert get("/templates")["templates"] == []
    blank = post("/robot-systems", {"name": "空白底盘项目"})
    assert not blank["configured"]
    post("/robot-systems/" + blank["id"] + "/select-blank", {})
    assert get("/robot-systems")["selected_id"] == blank["id"]
    assert get("/templates")["templates"] == []
    demo = post(
        "/robot-systems", {"name": "番茄采摘示例", "example_id": "tomato_picker"}
    )
    assert len(demo["content"]["backends"]) == 4
    job = post(
        "/robot-systems/" + demo["id"] + "/activate",
        {"request_id": "request_" + uuid.uuid4().hex},
    )["management_job_id"]
    for i in range(100):
        result = get("/management/jobs/" + job)
        if result["phase"] in ("completed", "failed", "blocked", "rolled_back"):
            break
        time.sleep(0.15)
    assert result["phase"] == "completed", result
    listing = get("/robot-systems")
    assert listing["active"] and listing["selected_id"] == demo["id"], listing
    assert get("/system/status")["system_id"] == demo["id"]
    assert get("/templates")["templates"][0]["id"] == "tomato_picker"
    assert get("/robot-systems")["systems"][1]["name"] == "番茄采摘示例"
    status = get("/system/status")
    assert status["state"] == "STOPPED"
    post("/system/start", {"request_id": "request_" + uuid.uuid4().hex})
    for i in range(60):
        if get("/system/status")["state"] == "READY":
            break
        time.sleep(0.15)
    blocked = client.post("/robot-systems/" + blank["id"] + "/select-blank", json={})
    assert (
        blocked.status_code == 409
        and blocked.json()["errors"][0]["code"] == "apply_not_stopped"
    ), blocked.text
    post("/system/stop", {"request_id": "request_" + uuid.uuid4().hex})
    for i in range(60):
        if get("/system/status")["state"] == "STOPPED":
            break
        time.sleep(0.15)
    post("/robot-systems/" + blank["id"] + "/select-blank", {})
    assert get("/templates")["templates"] == []
    job = post(
        "/robot-systems/" + demo["id"] + "/activate",
        {"request_id": "request_" + uuid.uuid4().hex},
    )["management_job_id"]
    for i in range(100):
        result = get("/management/jobs/" + job)
        if result["phase"] in ("completed", "failed", "blocked", "rolled_back"):
            break
        time.sleep(0.15)
    assert result["phase"] == "completed", result
    assert get("/robot-systems")["active"] and len(get("/templates")["templates"]) == 1
    print(
        "PASS: empty library, blank system, imported four-backend example, activation, template scoping, persistent selection"
    )
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    log.close()
    print("Agent log:", state / "agent.log")
