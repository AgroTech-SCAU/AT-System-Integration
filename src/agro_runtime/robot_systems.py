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
        connections = {item['id']: item for item in self.store.list('ros_connection')}
        profiles = {item['id']: item['path'] for item in self.store.list('robot_profile')}
        return {
            "systems": [{**item, 'connection': connections.get(item['id']), 'storage_path': profiles.get(item['id'])}
                        for item in self.store.list("robot_system")],
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

    def _name(self, name):
        name = str(name or "").strip()
        if not name or len(name) > 60:
            fail("$.name", "invalid_name", "机器人名称需为 1–60 个字符")
        return name

    def _available_name(self, name):
        name = self._name(name)
        existing = {item['name'].casefold() for item in self.store.list('robot_system')}
        candidate, index = name, 2
        while candidate.casefold() in existing:
            suffix = f' {index}'
            candidate = name[:60 - len(suffix)].rstrip() + suffix
            index += 1
        return candidate

    def rename(self, key, name, revision):
        record = self.store.get('robot_system', key)
        if record['revision'] != revision:
            fail('$.revision', 'revision_conflict', '机器人信息已改变，请刷新后重试')
        name = self._name(name)
        if any(item['id'] != key and item['name'].casefold() == name.casefold()
               for item in self.store.list('robot_system')):
            fail('$.name', 'duplicate_name', '已有同名机器人，请使用其他名称')
        return self.store.put('robot_system', key, {**record, 'name': name, 'revision': revision + 1})

    def create(self, name, example_id=None):
        name = self._available_name(name)
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
            self.store.db.execute("DELETE FROM documents WHERE kind='robot_profile' AND id=?", (key,))
            for kind in ("tree_draft", "plan", "state_machine", "ros_task", "ros_resource", "ros_binding"):
                for row in self.store.list(kind):
                    if row.get("robot_system_id") == key:
                        self.store.db.execute(
                            "DELETE FROM documents WHERE kind=? AND id=?",
                            (kind, row["id"]),
                        )
            self.store.db.execute("DELETE FROM documents WHERE kind='interface_foundation' AND id=?", (key,))
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
                "id": item["id"],
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
        referenced_trees = {state.get(phase) for machine in self.store.list('state_machine')
                            if machine.get('robot_system_id') == key for state in machine['document']['states']
                            for phase in ('entry', 'do', 'exit')}
        published = [
            {
                "id": item["id"],
                "policy": item["manifest"]["kind"],
                "document": item["document"],
                "layout": item["layout"],
                "parameters": item["parameters"],
            }
            for item in self.store.list("tree_definition")
            if item.get("robot_system_id") == key and not item.get('test_only') and
                (item['id'] in referenced_trees or not any(draft['id'] == item.get('draft_id') for draft in drafts))
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
            {'name': row['name'], 'document': copy.deepcopy(row['document']), 'layout':copy.deepcopy(row.get('layout', {'positions':{}}))}
            for row in self.store.list('state_machine')
            if row.get('robot_system_id') == key
        ]
        state_machines.extend(copy.deepcopy(record.get('pending_state_machines', [])))
        from .interface_sources import InterfaceWorkspaces
        interface_workspaces = InterfaceWorkspaces(self.store, key).records()
        ros_tasks = [
            {field:copy.deepcopy(value) for field,value in row.items() if field not in ('robot_system_id','revision')}
            for row in self.store.list('ros_task')
            if row.get('robot_system_id') == key
        ]
        bindings = {item['task_id']: item['interface'] for item in self.store.list('ros_binding') if item['robot_system_id'] == key}
        for task in ros_tasks:
            task['interface'] = bindings.get(task['id'], task.get('interface', ''))
        definitions_by_id = {item['id']: item for item in self.store.list('tree_definition')}
        for draft in drafts:
            original = definitions_by_id.get(draft.get('id'))
            if not original:
                continue
            remap = {}
            for frozen in original.get('ros_tasks', []):
                portable = {field: copy.deepcopy(value) for field, value in frozen.items()
                            if field not in ('robot_system_id', 'revision', '_ros_domain', 'interface_schema')}
                existing = next((item for item in ros_tasks if item['id'] == portable['id']), None)
                if existing and encoded(existing) == encoded(portable):
                    continue
                portable['id'] = 'ros_' + hashlib.sha256(encoded(portable).encode()).hexdigest()[:32]
                remap['RosTask_' + frozen['id']] = 'RosTask_' + portable['id']
                if not any(item['id'] == portable['id'] for item in ros_tasks):
                    ros_tasks.append(portable)
            for tree in draft['document']['trees'].values():
                for node in tree['nodes'].values():
                    node['registration_id'] = remap.get(node['registration_id'], node['registration_id'])
        catalog_record = next((item for item in self.store.list('interface_catalog') if item['id'] == key), {})
        schema_ids = {task.get('schema_id') for task in ros_tasks}
        schemas = [item for item in self.store.list('ros_schema') if item.get('project_id') == key and
                   (item.get('id') in schema_ids or item.get('id') in catalog_record.get('schema_ids', []) and
                    item['ros_type'] in catalog_record.get('primary_types', [item['ros_type']]))]
        foundation = next((item for item in self.store.list('interface_foundation') if item['id'] == key), {})
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
            "ros_tasks": ros_tasks,
            "interface_workspaces": [{**{field: copy.deepcopy(item[field]) for field in ('id', 'name', 'definitions')},
                                      'mode': 'files', 'path': '', 'icon': item.get('icon', 'generic'),
                                      'communications': copy.deepcopy(item.get('communications', {'endpoints': []})),
                                      'field_notes': copy.deepcopy(item.get('field_notes', {}))}
                                     for item in interface_workspaces],
            "interface_foundation": copy.deepcopy(foundation.get("definitions", {})),
            "interface_definitions": [{field: value for field, value in item.items() if field not in ('project_id', 'source')}
                                      for item in schemas],
            "interface_selection": [item['id'] for item in schemas if item['id'] in catalog_record.get('schema_ids', [])],
            "notes": "工程携带离线设计定义，执行前检查机器人绑定与运行环境",
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
            "ros_tasks",
            "interface_definitions",
            "interface_selection",
            "interface_workspaces",
            "interface_foundation",
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
        imported_ros_tasks = bundle.get("ros_tasks", [])
        if (
            not isinstance(descriptors, list)
            or not isinstance(drafts, list)
            or not isinstance(plans, list)
            or not isinstance(imported_machines,list) or len(imported_machines)>80
            or not isinstance(imported_ros_tasks,list) or len(imported_ros_tasks)>100
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
        tree_refmap = {}
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
            draft_id = 'draft_' + uuid4().hex
            original_id = item.get('id')
            if original_id:
                if not isinstance(original_id, str) or original_id in tree_refmap:
                    fail('$.task_drafts', 'invalid_id', '行为标识无效或重复')
                tree_refmap[original_id] = draft_id
            clean_drafts.append(
                {
                    "id": draft_id,
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
        # 新项目使用新任务标识，原状态机引用同步重映射
        from .ros_tasks import validate_task, IDENT as ROS_IDENT
        clean_ros_tasks = []
        ros_refmap = {}
        for i, item in enumerate(imported_ros_tasks):
            task = validate_task(item)
            original = task.get('id')
            if not isinstance(original,str) or not ROS_IDENT.fullmatch(original) or not original.startswith('ros_') or 'ros:'+original in ros_refmap:
                fail(f'$.ros_tasks[{i}].id','invalid_id','导入的通信任务标识无效或重复')
            identity = 'ros_' + uuid4().hex
            ros_refmap['ros:'+original] = 'ros:'+identity
            clean_ros_tasks.append({**task,'id':identity,'robot_system_id':key,'revision':1})
        for draft in clean_drafts:
            for tree in draft['document']['trees'].values():
                for node in tree['nodes'].values():
                    registration = node['registration_id']
                    if registration.startswith('RosTask_'):
                        mapped = ros_refmap.get('ros:' + registration[8:])
                        if not mapped:
                            fail('$.task_drafts', 'missing_task', '行为树引用的任务未包含在工程中')
                        node['registration_id'] = 'RosTask_' + mapped[4:]
        from .ros_interfaces import InterfaceLibrary, TYPE, _identity
        transfer_schemas = bundle.get('interface_definitions', [])
        if not isinstance(transfer_schemas, list) or len(transfer_schemas) > 1000:
            fail('$.interface_definitions', 'invalid_definitions', '工程接口定义清单无效')
        schema_refmap, clean_schemas = {}, []
        library = InterfaceLibrary(self.store, key)
        foundation = bundle.get('interface_foundation', {})
        if not isinstance(foundation, dict) or len(foundation) > 3000 or any(
            not isinstance(name, str) or not TYPE.fullmatch(name) or not isinstance(content, str) or len(content.encode()) > 262144
            for name, content in foundation.items()
        ):
            fail('$.interface_foundation', 'invalid_definitions', '基础接口快照需要包含原生接口定义')
        transfer_workspaces = bundle.get('interface_workspaces', [])
        if not isinstance(transfer_workspaces, list) or len(transfer_workspaces) > 64:
            fail('$.interface_workspaces', 'invalid_workspaces', '工程子系统 ROS2 工作区清单无效')
        workspace_refmap, clean_workspaces, workspace_names = {}, [], set()
        for item in transfer_workspaces:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or item['id'] in workspace_refmap:
                fail('$.interface_workspaces', 'invalid_workspaces', '子系统 ROS2 工作区标识无效或重复')
            name, mode, path = item.get('name'), item.get('mode'), item.get('path', '')
            icon = item.get('icon', 'generic')
            if icon not in ('generic', 'navigation', 'arm', 'vision', 'operations', 'mechanical', 'electrical'):
                fail('$.interface_workspaces', 'invalid_icon', '请选择子系统图标')
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or name.strip() in workspace_names or mode not in ('source', 'installed', 'files') or not isinstance(path, str):
                fail('$.interface_workspaces', 'invalid_workspaces', '子系统 ROS2 工作区名称或来源无效')
            definitions = item.get('definitions')
            if not isinstance(definitions, dict) or len(definitions) > 3000 or any(
                not isinstance(ros_type, str) or not TYPE.fullmatch(ros_type) or not isinstance(content, str) or len(content.encode()) > 262144
                for ros_type, content in definitions.items()
            ):
                fail('$.interface_workspaces', 'invalid_definitions', '子系统 ROS2 工作区需要包含原生接口定义')
            _, diagnostics = library.compile(definitions, allow_partial=True, saved_definitions=False)
            identity = 'workspace_' + uuid4().hex
            workspace_refmap[item['id']] = identity
            workspace_names.add(name.strip())
            clean_workspaces.append({'id': identity, 'project_id': key, 'name': name.strip(), 'icon': icon, 'mode': mode,
                                     'path': path, 'definitions': definitions, 'diagnostics': diagnostics})
            from .offline_communications import portable_communications
            if 'communications' in item:
                clean_workspaces[-1]['communications'] = portable_communications(item['communications'])
            notes = item.get('field_notes', {})
            if not isinstance(notes, dict) or len(notes) > 3000 or len(json.dumps(notes)) > 524288 or any(
                not isinstance(value, dict) or not isinstance(value.get('definition_key'), str) or not isinstance(value.get('fields'), dict)
                for value in notes.values()):
                fail('$.field_notes', 'invalid_notes', '字段说明格式无效')
            clean_workspaces[-1]['field_notes'] = copy.deepcopy(notes)

        for item in transfer_schemas:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or item['id'] in schema_refmap:
                fail('$.interface_definitions', 'invalid_definitions', '接口定义标识无效或重复')
            definitions = item.get('definitions', {})
            if not isinstance(definitions, dict) or not definitions or len(definitions) > 1000 or any(
                not TYPE.fullmatch(name) or not isinstance(content, str) or len(content.encode()) > 262144
                for name, content in definitions.items()
            ):
                fail('$.interface_definitions', 'invalid_definitions', '工程需要包含原生接口定义及依赖')
            schemas = library.compile(definitions, saved_definitions=False)
            ros_type = item.get('ros_type')
            supplied = item.get('schema')
            expected = {name: value for name, value in schemas.get(ros_type, {}).items()
                        if not name.endswith('_schemas') or isinstance(supplied, dict) and name in supplied}
            if ros_type not in schemas or expected != supplied:
                fail('$.interface_definitions', 'schema_mismatch', '接口字段与原生定义不一致')
            identity = _identity(key + ':' + item['id'])
            schema_refmap[item['id']] = identity
            clean_schemas.append({'id': identity, 'project_id': key, 'ros_type': ros_type, 'schema': schemas[ros_type],
                                  'definitions': definitions, 'definition': definitions[ros_type], 'source': 'imported'})
        for task in clean_ros_tasks:
            workspace_ids = task.get('workspace_ids', [])
            if any(identity not in workspace_refmap for identity in workspace_ids):
                fail('$.interface_workspaces', 'missing_workspace', '任务引用的子系统 ROS2 工作区未包含在工程中：' + task['name'])
            if 'interface_workspaces' in bundle:
                task['workspace_ids'] = [workspace_refmap[identity] for identity in workspace_ids]
            if task.get('schema_id'):
                if task['schema_id'] not in schema_refmap:
                    fail('$.interface_definitions', 'missing_definition', '任务缺少所引用的接口定义：' + task['name'])
                task['schema_id'] = schema_refmap[task['schema_id']]
                schema = next(item for item in clean_schemas if item['id'] == task['schema_id'])
                if schema['ros_type'] != task['ros_type']:
                    fail('$.ros_tasks', 'schema_mismatch', '任务与所引用的接口定义类型不一致')
        selection = bundle.get('interface_selection', list(schema_refmap))
        if not isinstance(selection, list) or any(not isinstance(identity, str) or identity not in schema_refmap for identity in selection):
            fail('$.interface_selection', 'invalid_selection', '选用的接口定义未包含在工程中')
        selected_schemas = {}
        for identity in selection:
            schema = next(item for item in clean_schemas if item['id'] == schema_refmap[identity])
            selected_schemas[schema['ros_type']] = schema['id']
        from .state_machines import validate as validate_state_machine
        clean_machines = []
        for i, item in enumerate(imported_machines):
            if not isinstance(item,dict) or not isinstance(item.get('document'),dict):
                fail(f'$.state_machines[{i}]','invalid_machine','状态机工程结构无效')
            document = copy.deepcopy(item['document'])
            needs_rebinding = False
            for state in document.get('states',[]):
                if isinstance(state,dict):
                    for field in ('entry','do','exit'):
                        ref=state.get(field)
                        if isinstance(ref,str) and ref in ros_refmap:
                            state[field]=ros_refmap[ref]
                        elif isinstance(ref,str) and ref in tree_refmap:
                            state[field]=tree_refmap[ref]
                        elif ref:
                            state.pop(field,None)
                            needs_rebinding=True
            document = validate_state_machine(document,clean_drafts,clean_ros_tasks)
            layout=item.get('layout') or {'positions':{}}
            positions=layout.get('positions',{}) if isinstance(layout,dict) else {}
            keys={state['id'] for state in document['states']}
            if not isinstance(positions,dict) or len(positions)>48 or any(
                key not in keys or not isinstance(point,list) or len(point)!=2 or
                any(type(v) not in (int,float) or not 0<=v<=12000 for v in point)
                for key,point in positions.items()
            ):
                fail(f'$.state_machines[{i}].layout','invalid_layout','画布布局无效')
            clean_machines.append({'name':str(item.get('name') or '导入状态机')[:80], 'document': document, 'layout':{'positions':copy.deepcopy(positions)}, 'needs_tree_rebinding':needs_rebinding})
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
            "name": self._available_name(name),
            "example_id": example,
            "content": content,
            "configured": bool(system.get("configured")),
            "revision": 1,
            "pending_task_drafts": [],
            "pending_task_plans": clean_plans,
            "pending_state_machines": clean_machines,
        }
        self.store.put("robot_system", key, record)
        for draft in clean_drafts:
            self.store.put('tree_draft', draft['id'], {**draft, 'revision': 1, 'layout_revision': 1,
                'base_snapshot_id': self.context.snapshot_id, 'validation': None, 'published': None, 'robot_system_id': key})
        self.store.put_many('ros_schema', [(item['id'], item) for item in clean_schemas])
        self.store.put_many('interface_workspace', [(item['id'], item) for item in clean_workspaces])
        if foundation:
            self.store.put('interface_foundation', key, {'id': key, 'path': '', 'definitions': foundation})
        self.store.put('interface_catalog', key, {'id': key, 'schema_ids': list(selected_schemas.values()),
            'sources': [], 'base_path': '', 'choices': {}, 'primary_types': list(selected_schemas),
            'workspaces_migrated': 'interface_workspaces' in bundle,
            'default_workspace_ids': [clean_workspaces[0]['id']] if len(clean_workspaces) == 1 else []})
        for item in clean_ros_tasks:
            endpoint = item.pop('interface', '')
            self.store.put('ros_task',item['id'],item)
            binding_id = key + '_' + item['id']
            self.store.put('ros_binding', binding_id, {'id': binding_id, 'task_id': item['id'], 'robot_system_id': key, 'interface': endpoint})
        for machine in clean_machines:
            mid='machine_'+uuid4().hex
            self.store.put('state_machine',mid,{'id':mid,'name':machine['name'],'document':machine['document'],'layout':machine.get('layout',{'positions':{}}),'revision':1,'robot_system_id':key,'needs_tree_rebinding':machine['needs_tree_rebinding']})
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
        if getattr(self, 'deployment', None) and (self.deployment.has_processes() or self.deployment.lock.locked()):
            fail('$.modules', 'modules_running', '请先在运行台停止子系统，再切换机器人')
        if any(r['snapshot']['state'] in {'ACCEPTED','RUNNING','CANCELING','UNKNOWN'} or r['snapshot']['stop_state']=='UNCONFIRMED' for r in self.store.list('ros_operation')):
            fail('$.operations','operation_not_stopped','ROS 操作停止未确认，不能切换系统')
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
        self.restore_imported_tasks(record)
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
