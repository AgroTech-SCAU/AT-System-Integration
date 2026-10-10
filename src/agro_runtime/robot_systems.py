"""机器人系统工作区：实例与范例分离，选中不等于启动设备"""

import copy
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from .configuration import encoded
from .errors import fail
from .registry import read_document, Registry, bind_system
from .models import PackageDescriptor, SystemConfig
from .errors import parse
from .runtime import runtime_plan


class RobotSystems:
    def __init__(self, context, store, configuration):
        self.context = context
        self.store = store
        self.configuration = configuration
        self.example = (
            Path(__file__).resolve().parents[2] / "examples" / "tomato_picker"
        )

    def selected_id(self):
        rows = self.store.list("robot_selection")
        return rows[0]["system_id"] if rows else None

    def selected(self):
        key = self.selected_id()
        if not key:
            return None
        return next(
            (item for item in self.store.list("robot_system") if item["id"] == key),
            None,
        )

    def active(self, record=None):
        record = record or self.selected()
        if not record or not record.get("configured"):
            return False
        effective = self.configuration.validate(record["content"])
        if not effective["valid"]:
            return False
        return encoded(effective["effective"]) == encoded(
            self.context.bound.config.model_dump(mode="json")
        )

    def listing(self):
        return {
            "systems": self.store.list("robot_system"),
            "selected_id": self.selected_id(),
            "active": self.active(),
            "running_state": self.context.state,
            "examples": [
                {
                    "id": "tomato_picker",
                    "title": "番茄采摘机器人",
                    "description": "四类独立模拟后端、共享场景、标定资产和完整采摘行为树",
                    "simulation": True,
                }
            ],
        }

    def create(self, name, example_id=None):
        name = str(name or "").strip()
        if not name or len(name) > 60:
            fail("$.name", "invalid_name", "系统名称需为 1–60 个字符")
        if example_id not in (None, "tomato_picker"):
            fail("$.example_id", "unknown_example", "不存在此示例")
        key = "robot_" + uuid4().hex
        system_id = key  # 实例拥有自己的系统身份，不与示例共用
        if example_id == "tomato_picker":
            content = read_document(self.example / "system_four_backends.yaml")
            content["system_id"] = system_id
            content["packages"] = ["packages/tomato_simulator.yaml"]
            if not any(
                item["id"] == "tomato_simulator"
                for item in self.configuration.catalog()
            ):
                self.configuration.import_package(
                    "tomato_simulator.yaml",
                    (self.example / "package.yaml").read_text(encoding="utf-8"),
                )
            valid = self.configuration.validate(content)
            if not valid["valid"]:
                fail(
                    "$.example_id",
                    "example_invalid",
                    "示例配置校验失败，请先核对接入包",
                )
        else:
            content = {
                "system_id": system_id,
                "packages": [],
                "backends": [],
                "required_roles": [],
                "roles": {},
            }
        record = {
            "id": key,
            "name": name,
            "example_id": example_id,
            "content": content,
            "configured": bool(example_id),
            "revision": 1,
        }
        self.store.put("robot_system", key, record)
        # 新建仅持久化项目，不自动启动后端、不切换正在运行的机器人
        return record

    def delete(self, key):
        """Remove a saved project, but never remove an active robot or operation history."""
        record = self.store.get("robot_system", key)
        self.require_stopped()
        if self.selected_id() == key and self.active(record):
            fail(
                "$.system_id", "selected_system_active",
                "当前系统配置仍在使用，请先选择其他系统，再删除此系统",
            )
        # All affected workspace records are removed in one transaction, so a
        # cancelled or failed deletion cannot leave a half-deleted project
        with self.store.db:
            for kind in ("tree_draft", "plan", "state_machine"):
                for row in self.store.list(kind):
                    if row.get("robot_system_id") == key:
                        self.store.db.execute(
                            "DELETE FROM documents WHERE kind=? AND id=?",
                            (kind, row["id"]),
                        )
            self.store.db.execute(
                "DELETE FROM documents WHERE kind='robot_system' AND id=?", (key,)
            )
            if self.selected_id() == key:
                self.store.db.execute(
                    "DELETE FROM documents WHERE kind='robot_selection' AND id='current'"
                )
        # Published definitions and execution records are retained for audit
        return self.listing()

    def export_bundle(self, key):
        """Portable declarative project; no tokens, machine paths, snapshots or control records."""
        record = self.store.get("robot_system", key)
        package_ids = list(
            dict.fromkeys(
                item["package_id"] for item in record["content"].get("backends", [])
            )
        )
        catalog = {item["id"]: item for item in self.configuration.catalog()}
        missing = [name for name in package_ids if name not in catalog]
        if missing:
            fail(
                "$.packages",
                "missing_dependencies",
                "系统依赖的接入包描述不存在: " + ", ".join(missing),
            )
        drafts = [
            {
                "policy": item["policy"],
                "document": item["document"],
                "layout": item["layout"],
                "parameters": item["parameters"],
            }
            for item in self.store.list("tree_draft")
            if item.get("robot_system_id") == key
        ]
        # 已发布定义也作为可移植的“待重新校验草稿”，绝不移植其执行授权和本机路径
        drafts.extend(copy.deepcopy(record.get("pending_task_drafts", [])))
        published = [
            {
                "policy": item["manifest"]["kind"],
                "document": item["document"],
                "layout": item["layout"],
                "parameters": item["parameters"],
            }
            for item in self.store.list("tree_definition")
            if item.get("robot_system_id") == key
        ]
        for item in published:
            if not any(encoded(item) == encoded(existing) for existing in drafts):
                drafts.append(item)
        plans = [
            {"template_id": item["template_id"], "parameters": item["parameters"]}
            for item in self.store.list("plan")
            if item.get("robot_system_id") == key
        ]
        plans.extend(copy.deepcopy(record.get("pending_task_plans", [])))
        assets = []
        referenced = {
            item.get("asset_id")
            for item in self.store.list("plan")
            if item.get("robot_system_id") == key
        }
        for asset in self.store.list("asset"):
            if asset["id"] not in referenced:
                continue
            path = self.store.root / "assets" / (asset["sha256"] + ".json")
            if not path.is_file():
                fail("$.assets", "missing_asset", "任务引用的标定资产丢失")
            content_text = path.read_text(encoding="utf-8")
            if (
                hashlib.sha256(content_text.encode("utf-8")).hexdigest()
                != asset["sha256"]
            ):
                fail("$.assets", "asset_checksum_mismatch", "标定资产摘要不匹配")
            assets.append(
                {
                    "filename": asset["filename"],
                    "sha256": asset["sha256"],
                    "content": content_text,
                }
            )
        # 导入后尚未激活的工程也能再次导出，保留其内置模拟标定资产
        if not assets and record.get("pending_task_plans"):
            asset_text = (self.example / "assets" / "camera_to_arm.json").read_text(
                encoding="utf-8"
            )
            assets.append(
                {
                    "filename": "camera_to_arm.json",
                    "sha256": hashlib.sha256(asset_text.encode()).hexdigest(),
                    "content": asset_text,
                }
            )
        state_machines = [
            {'name': row['name'], 'document': copy.deepcopy(row['document'])}
            for row in self.store.list('state_machine')
            if row.get('robot_system_id') == key
        ]
        state_machines.extend(copy.deepcopy(record.get('pending_state_machines', [])))
        bundle = {
            "format": "agrotech.robot-system",
            "format_version": 1,
            "system": {
                "name": record["name"],
                "example_id": record.get("example_id"),
                "configured": record["configured"],
                "configuration": copy.deepcopy(record["content"]),
            },
            "packages": [catalog[name]["description"] for name in package_ids],
            "assets": assets,
            "task_drafts": drafts,
            "task_plans": plans,
            "state_machines": state_machines,
            "notes": "任务定义导入后仅作为草稿，需要重新校验及发布；设备运行状态与凭据不导出",
        }
        if len(encoded(bundle).encode("utf-8")) > 6 * 1024 * 1024:
            fail("$.bundle", "bundle_too_large", "工程文件超过 6 MiB，请精简任务草稿")
        return bundle

    def import_bundle(self, bundle):
        """Validate first; create a new, inactive project; never activate hardware here."""
        if (
            not isinstance(bundle, dict)
            or bundle.get("format") != "agrotech.robot-system"
            or type(bundle.get("format_version")) is not int
            or bundle["format_version"] != 1
        ):
            fail("$.format", "unsupported_project", "不是受支持的机器人系统工程文件")
        if len(encoded(bundle).encode("utf-8")) > 6 * 1024 * 1024:
            fail("$.bundle", "bundle_too_large", "工程文件不能超过 6 MiB")
        if set(bundle) - {
            "format",
            "format_version",
            "system",
            "packages",
            "task_drafts",
            "task_plans",
            "state_machines",
            "assets",
            "notes",
        }:
            fail("$.bundle", "unexpected_fields", "工程文件包含未支持字段")
        system = bundle.get("system")
        if not isinstance(system, dict) or not isinstance(
            system.get("configuration"), dict
        ):
            fail("$.system", "invalid_project", "工程缺少机器人系统配置")
        name = system.get("name")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
            fail("$.name", "invalid_name", "系统名称应为 1–60 个字符")
        example = system.get("example_id")
        if example not in (None, "tomato_picker"):
            fail("$.example_id", "unknown_example", "工程使用了未知示例类型")
        descriptors = bundle.get("packages")
        transfer_assets = bundle.get("assets", [])
        drafts = bundle.get("task_drafts", [])
        plans = bundle.get("task_plans", [])
        imported_machines = bundle.get("state_machines", [])
        if (
            not isinstance(descriptors, list)
            or not isinstance(drafts, list)
            or not isinstance(plans, list)
            or not isinstance(imported_machines,list) or len(imported_machines)>80
            or not isinstance(transfer_assets, list)
            or len(transfer_assets) > 50
            or len(drafts) > 100
            or len(plans) > 100
        ):
            fail(
                "$.bundle",
                "invalid_project",
                "接入包或任务清单无效，任务数量不能超过 100",
            )
        registry = Registry()
        imported = {}
        for item in descriptors:
            desc = parse(PackageDescriptor, item)
            registry.register(desc)
            imported[desc.package_id] = desc.model_dump(mode="json")
        configured = system.get("configured")
        if type(configured) is not bool:
            fail("$.configured", "invalid_project", "工程需要明确声明是否已配置")
        if configured:
            old_config = parse(SystemConfig, system["configuration"])
            config_data = old_config.model_dump(mode="json")
            expected_ids = {entry.package_id for entry in old_config.backends}
        else:
            raw = system["configuration"]
            if (
                set(raw)
                != {"system_id", "packages", "backends", "required_roles", "roles"}
                or not isinstance(raw["system_id"], str)
                or raw["packages"] != []
                or raw["backends"] != []
                or raw["required_roles"] != []
                or raw["roles"] != {}
            ):
                fail(
                    "$.configuration",
                    "invalid_blank_project",
                    "空白机器人系统不能附带后端或角色配置",
                )
            config_data = copy.deepcopy(raw)
            expected_ids = set()
        if set(imported) != expected_ids or set(config_data["packages"]) != {
            "packages/" + pid + ".yaml" for pid in expected_ids
        }:
            fail(
                "$.packages",
                "dependency_mismatch",
                "工程包必须完整包含所有且仅包含所引用的接入描述",
            )
        existing = {
            item["id"]: item["description"] for item in self.configuration.catalog()
        }
        for pid, desc in imported.items():
            if pid in existing and encoded(existing[pid]) != encoded(desc):
                fail(
                    "$.packages",
                    "package_conflict",
                    "接入包标识冲突，请先核对同名接入包: " + pid,
                )
        # 新建唯一身份，防止覆盖已有项目；全部静态校验在写入前完成
        key = "robot_" + uuid4().hex
        content = config_data
        content["system_id"] = key
        if configured:
            registry_for_project = Registry()
            for desc in imported.values():
                registry_for_project.register(parse(PackageDescriptor, desc))
            bound = bind_system(content, registry_for_project)
            runtime_plan(bound, registry_for_project)
            if any(entry.native_config is not None for entry in bound.config.backends):
                fail(
                    "$.backends",
                    "native_validator_required",
                    "工程中包含无法校验的原生设备配置",
                )
        from .tree_models import TreeDocument, LayoutDocument

        clean_drafts = []
        for i, item in enumerate(drafts):
            if (
                not isinstance(item, dict)
                or item.get("policy") not in ("general", "tomato_picker", "simulation_inspection")
                or not isinstance(item.get("parameters"), dict)
            ):
                fail(f"$.task_drafts[{i}]", "invalid_task_draft", "任务草稿格式无效")
            if item["policy"] == "tomato_picker" and example != "tomato_picker":
                fail(
                    f"$.task_drafts[{i}]",
                    "template_not_imported",
                    "番茄任务必须依附番茄示例系统",
                )
            clean_drafts.append(
                {
                    "policy": item["policy"],
                    "document": parse(TreeDocument, item.get("document")).model_dump(
                        mode="json"
                    ),
                    "layout": parse(LayoutDocument, item.get("layout")).model_dump(
                        mode="json"
                    ),
                    "parameters": copy.deepcopy(item["parameters"]),
                }
            )
        # 导入不信任旧机器的已发布定义 ID，状态结构保留，动作引用必须重新关联
        from .state_machines import validate as validate_state_machine
        clean_machines = []
        for i, item in enumerate(imported_machines):
            if not isinstance(item,dict) or not isinstance(item.get('document'),dict):
                fail(f'$.state_machines[{i}]','invalid_machine','状态机工程结构无效')
            document = copy.deepcopy(item['document'])
            for state in document.get('states',[]):
                if isinstance(state,dict):
                    for field in ('entry','do','exit'):
                        state.pop(field,None)
            document = validate_state_machine(document,())
            clean_machines.append({'name':str(item.get('name') or '导入状态机')[:80], 'document': document, 'needs_tree_rebinding':True})
        # 当前资产系统只认可内置模拟标定证据；未来真实标定须由独立校验器接入
        allowed_fixture = json.loads(
            (self.example / "assets" / "camera_to_arm.json").read_text(encoding="utf-8")
        )
        for i, asset in enumerate(transfer_assets):
            if not isinstance(asset, dict) or set(asset) != {
                "filename",
                "content",
                "sha256",
            }:
                fail(f"$.assets[{i}]", "invalid_asset", "标定资产格式无效")
            content_text = asset["content"]
            if (
                not isinstance(content_text, str)
                or len(content_text.encode()) > 1024 * 1024
            ):
                fail(f"$.assets[{i}]", "invalid_asset", "标定资产内容无效")
            if hashlib.sha256(content_text.encode()).hexdigest() != asset["sha256"]:
                fail(f"$.assets[{i}]", "asset_checksum_mismatch", "标定资产摘要不匹配")
            try:
                decoded_asset = json.loads(content_text)
            except ValueError:
                fail(f"$.assets[{i}]", "invalid_asset", "标定资产不是 JSON")
            if decoded_asset != allowed_fixture:
                fail(
                    f"$.assets[{i}]",
                    "unsupported_asset",
                    "暂不支持导入未验证的真实标定资产",
                )
        if plans and not transfer_assets:
            # 兼容早期导出：内置示例资产仍可由本地例程重建
            if example != "tomato_picker":
                fail("$.assets", "missing_asset", "模板任务缺少标定资产")
        clean_plans = []
        if plans:
            from .tasks import TaskManifest
            from .registry import _values

            template_manifest = parse(
                TaskManifest,
                read_document(self.example / "tasks" / "harvest.task.json"),
            )
        for i, item in enumerate(plans):
            if (
                not isinstance(item, dict)
                or item.get("template_id") != "tomato_picker"
                or example != "tomato_picker"
                or not isinstance(item.get("parameters"), dict)
            ):
                fail(
                    f"$.task_plans[{i}]",
                    "invalid_task_plan",
                    "工程包含未知或不兼容的模板任务",
                )
            clean_plans.append(
                {
                    "template_id": "tomato_picker",
                    "parameters": _values(
                        item["parameters"],
                        template_manifest.parameters,
                        f"$.task_plans[{i}].parameters",
                        parameters=True,
                    ),
                }
            )
        for pid, desc in imported.items():
            if pid not in existing:
                import yaml

                self.configuration.import_package(
                    pid + ".yaml",
                    yaml.safe_dump(desc, allow_unicode=True, sort_keys=False),
                )
        record = {
            "id": key,
            "name": name.strip(),
            "example_id": example,
            "content": content,
            "configured": bool(system.get("configured")),
            "revision": 1,
            "pending_task_drafts": clean_drafts,
            "pending_task_plans": clean_plans,
            "pending_state_machines": clean_machines,
        }
        self.store.put("robot_system", key, record)
        for machine in clean_machines:
            mid='machine_'+uuid4().hex
            self.store.put('state_machine',mid,{'id':mid,'name':machine['name'],'document':machine['document'],'revision':1,'robot_system_id':key,'needs_tree_rebinding':True})
        record.pop('pending_state_machines',None)
        self.store.put('robot_system',key,record)
        return record

    def restore_imported_tasks(self, record):
        """Only after explicit selection and verified configuration. Imported execution artifacts remain drafts."""
        pending_drafts = record.get("pending_task_drafts", [])
        pending_plans = record.get("pending_task_plans", [])
        if not pending_drafts and not pending_plans:
            return
        for draft in pending_drafts:
            key = "draft_" + uuid4().hex
            self.store.put(
                "tree_draft",
                key,
                {
                    "id": key,
                    "revision": 1,
                    "layout_revision": 1,
                    "policy": draft["policy"],
                    "base_snapshot_id": self.context.snapshot_id,
                    "document": draft["document"],
                    "layout": draft["layout"],
                    "parameters": draft["parameters"],
                    "validation": None,
                    "published": None,
                    "robot_system_id": record["id"],
                },
            )
        if pending_plans:
            from .assets import AssetService

            assets = AssetService(self.context, self.store, self)
            for plan in pending_plans:
                assets.create_plan(
                    plan["parameters"], assets.builtin["id"], plan["template_id"]
                )
        record.pop("pending_task_drafts", None)
        record.pop("pending_task_plans", None)
        self.store.put("robot_system", record["id"], record)

    def require_stopped(self):
        if self.context.state != "STOPPED":
            fail("$.system", "apply_not_stopped", "请先确认机器人系统已经停止")
        if any(
            task["state"] in {"ACCEPTED", "RUNNING", "CANCELING", "UNKNOWN"}
            or not task["stop_confirmed"]
            for task in self.context.tasks.list()
        ):
            fail("$.tasks", "task_not_stopped", "存在未确认停止的任务，不能切换系统")
        if any(
            item.state.value in {"ACCEPTED", "RUNNING", "CANCELING", "UNKNOWN"}
            or item.stop_state.value == "UNCONFIRMED"
            for item in self.context.records.list_operations()
        ):
            fail(
                "$.operations",
                "operation_not_stopped",
                "存在未确认停止的操作，不能切换系统",
            )

    def choose_blank(self, key):
        record = self.store.get("robot_system", key)
        if record["configured"]:
            fail("$.system_id", "activation_required", "已配置系统需要先执行安全切换")
        self.require_stopped()
        self.store.put(
            "robot_selection", "current", {"id": "current", "system_id": key}
        )
        return self.listing()

    def deselect(self):
        """Close the selected workspace, never bypassing physical stop confirmation."""
        self.require_stopped()
        with self.store.db:
            self.store.db.execute(
                "DELETE FROM documents WHERE kind='robot_selection' AND id='current'"
            )
        return self.listing()

    def set_configuration(self, key, revision, content):
        record = self.store.get("robot_system", key)
        if record["revision"] != revision:
            fail("$.revision", "revision_conflict", "系统配置已改变，请刷新后重试")
        if content.get("system_id") != record["content"]["system_id"]:
            fail(
                "$.system_id", "immutable_system_identity", "系统实例的唯一标识不能改变"
            )
        result = self.configuration.validate(content)
        if not result["valid"]:
            fail("$.content", "invalid_configuration", "系统配置未通过静态校验")
        if encoded(result["effective"]) != encoded(
            self.context.bound.config.model_dump(mode="json")
        ):
            fail(
                "$.content",
                "configuration_not_active",
                "请先在停止态安全应用配置，再保存到机器人系统",
            )
        updated = {
            **record,
            "content": content,
            "configured": True,
            "revision": revision + 1,
        }
        self.store.put("robot_system", key, updated)
        self.store.put(
            "robot_selection", "current", {"id": "current", "system_id": key}
        )
        self.restore_imported_tasks(updated)
        return updated

    async def activate(self, key, phase):
        record = self.store.get("robot_system", key)
        if not record["configured"]:
            fail("$.system_id", "system_not_configured", "请先在系统搭建中完成配置")
        self.require_stopped()
        if not self.active(record):
            phase("preparing_configuration")
            draft = self.configuration.create_draft(
                self.context.snapshot_id, record["content"]
            )
            if not draft["validation"]["valid"]:
                fail(
                    "$.content",
                    "invalid_configuration",
                    "已保存的机器人配置已失效，请重新校验",
                )
            await self.configuration.apply(
                draft["id"], draft["revision"], draft["base_snapshot_id"], phase
            )
        self.store.put(
            "robot_selection", "current", {"id": "current", "system_id": key}
        )
        self.restore_imported_tasks(record)
        return {
            "system_id": key,
            "selected": True,
            "active": self.active(record),
            "snapshot_id": self.context.snapshot_id,
        }
