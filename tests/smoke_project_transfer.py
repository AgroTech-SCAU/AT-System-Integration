"""全新本地工作区之间：示例/任务 → 导出 → 导入 → 选择、失败场景"""

import copy
import os
import sqlite3
import json
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parents[1]
ENV = {
    **os.environ,
    "PYTHONPATH": os.pathsep.join(
        [str(ROOT / "src"), str(ROOT / "adapters"), os.environ.get("PYTHONPATH", "")]
    ),
}


class Agent:
    def __init__(self):
        self.state = Path(tempfile.mkdtemp(prefix="agro-transfer-"))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.log = (self.state / "agent.log").open("w")
        self.proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "agro_runtime.cli",
                "agent",
                "serve",
                "--config",
                str(ROOT / "examples/workspace/system.yaml"),
                "--state-dir",
                str(self.state),
                "--port",
                str(self.port),
            ],
            cwd=ROOT,
            env=ENV,
            stdout=self.log,
            stderr=subprocess.STDOUT,
        )
        for i in range(90):
            token = self.state / "session.token"
            if token.exists():
                self.http = httpx.Client(
                    base_url=f"http://127.0.0.1:{self.port}",
                    headers={"Authorization": "Bearer " + token.read_text().strip()},
                    timeout=5,
                )
                try:
                    if self.http.get("/robot-systems").status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
            if self.proc.poll() is not None:
                raise RuntimeError("agent exited")
            time.sleep(0.12)
        else:
            raise RuntimeError("agent timeout")

    def get(self, path):
        result = self.http.get(path)
        result.raise_for_status()
        return result.json()

    def post(self, path, data):
        result = self.http.post(path, json=data)
        if result.status_code >= 400:
            print("HTTP FAILURE:", result.status_code, result.text)
        result.raise_for_status()
        return result.json()

    def activate(self, system_id):
        job = self.post(
            f"/robot-systems/{system_id}/activate",
            {"request_id": "request_" + uuid.uuid4().hex},
        )["management_job_id"]
        for i in range(120):
            current = self.get("/management/jobs/" + job)
            if current["phase"] in ("completed", "failed", "blocked", "rolled_back"):
                break
            time.sleep(0.12)
        assert current["phase"] == "completed", current

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.http.close()
        self.log.close()


agents = []
try:
    source = Agent()
    agents.append(source)
    original = source.post(
        "/robot-systems", {"name": "示例迁移", "example_id": "tomato_picker"}
    )
    source.activate(original["id"])
    # Ensure plans and drafts are transferred as DECLARATIVE intents, not source-machine paths
    source.post(
        "/plans",
        {
            "template_id": "tomato_picker",
            "parameters": {"approach_dz": 0.1},
            "asset_id": None,
        },
    )
    # 测试环境未编译 BT.CPP 引擎；写入受 Pydantic 验证的最小编辑草稿以测试迁移层
    draft = {
        "id": "draft_migration_test",
        "revision": 1,
        "layout_revision": 1,
        "policy": "simulation_inspection",
        "base_snapshot_id": source.get("/system/status")["snapshot_id"],
        "document": {
            "main_tree_id": "Inspection",
            "revision": 1,
            "inputs": {},
            "model_digest": "must_revalidate",
            "trees": {
                "Inspection": {
                    "tree_id": "Inspection",
                    "root_id": "node_root",
                    "ports": {},
                    "nodes": {
                        "node_root": {
                            "editor_id": "node_root",
                            "registration_id": "Sequence",
                            "children": [],
                            "ports": {},
                            "attributes": {},
                        }
                    },
                }
            },
        },
        "layout": {
            "revision": 1,
            "positions": {},
            "labels": {},
            "collapsed": [],
            "zoom": 1.0,
        },
        "parameters": {},
        "validation": None,
        "published": None,
        "robot_system_id": original["id"],
    }
    with sqlite3.connect(source.state / "workspace/workspace.db") as db:
        db.execute(
            "INSERT OR REPLACE INTO documents(kind,id,body) VALUES (?,?,?)",
            ("tree_draft", draft["id"], json.dumps(draft)),
        )
    package = source.get("/robot-systems/" + original["id"] + "/export")
    assert package["format"] == "agrotech.robot-system"
    assert (
        len(package["packages"]) == 1
        and package["task_drafts"]
        and package["task_plans"]
    ), package
    assert "task_ref" not in str(package) and "session.token" not in str(package)
    print(
        "PASS: project export includes configuration, descriptors, draft and plan, excludes runtime paths"
    )
    target = Agent()
    agents.append(target)
    imported = target.post("/robot-systems/import", {"bundle": package})
    assert (
        imported["id"] != original["id"]
        and imported["content"]["system_id"] == imported["id"]
    )
    assert target.get("/robot-systems")["selected_id"] is None
    assert target.get("/templates")["templates"] == []
    print(
        "PASS: import creates a different, inactive project, no auto-select or auto-start"
    )
    preserved = target.get("/robot-systems/" + imported["id"] + "/export")
    assert len(preserved["task_plans"]) == len(package["task_plans"])
    assert len(preserved["task_drafts"]) == len(package["task_drafts"])
    assert len(preserved["assets"]) == len(package["assets"])
    print(
        "PASS: export-before-activation preserves imported plans, drafts and calibration assets"
    )
    target.activate(imported["id"])
    assert target.get("/robot-systems")["active"]
    assert target.get("/system/status")["system_id"] == imported["id"]
    assert len(target.get("/trees/drafts")["drafts"]) == len(package["task_drafts"])
    assert len(target.get("/plans")["plans"]) == len(package["task_plans"])
    assert target.get("/system/status")["state"] == "STOPPED"
    print(
        "PASS: imported project activates with migrated editable tree drafts and task plans"
    )
    # Duplicate import should never overwrite or select original project
    duplicate = target.post("/robot-systems/import", {"bundle": package})
    assert (
        duplicate["id"] != imported["id"]
        and target.get("/robot-systems")["selected_id"] == imported["id"]
    )
    print("PASS: duplicate import has isolated id and does not switch selected project")
    malicious = copy.deepcopy(package)
    malicious["packages"][0]["package_id"] = "different"
    response = target.http.post("/robot-systems/import", json={"bundle": malicious})
    assert (
        response.status_code == 409
        and response.json()["errors"][0]["code"] == "dependency_mismatch"
    ), response.text
    malicious = copy.deepcopy(package)
    malicious["format_version"] = 123
    response = target.http.post("/robot-systems/import", json={"bundle": malicious})
    assert (
        response.status_code == 409
        and response.json()["errors"][0]["code"] == "unsupported_project"
    ), response.text
    changed = copy.deepcopy(package)
    changed["assets"][0]["sha256"] = "0" * 64
    response = target.http.post("/robot-systems/import", json={"bundle": changed})
    assert (
        response.status_code == 409
        and response.json()["errors"][0]["code"] == "asset_checksum_mismatch"
    ), response.text
    print("PASS: rejects package mismatch, invalid asset hash and unsupported formats")
    blank = source.post("/robot-systems", {"name": "纯空白项目"})
    blank_bundle = source.get("/robot-systems/" + blank["id"] + "/export")
    restored = target.post("/robot-systems/import", {"bundle": blank_bundle})
    assert (
        not restored["configured"]
        and restored["content"]["system_id"] == restored["id"]
    )
    print(
        "PASS: blank systems can be exported and imported without introducing tomato resources"
    )
finally:
    for agent in reversed(agents):
        agent.close()
