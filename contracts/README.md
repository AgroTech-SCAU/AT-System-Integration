# 接入与执行契约

开发者通过契约声明能力、任务端口和运行数据，JSON Schema 描述字段结构，Python 入口补充单位、范围、默认值、角色兼容性与数据新鲜度校验

| 要定义或扩展的内容 | 权威模型与规则 |
| --- | --- |
| 包、系统、能力、执行请求与操作快照 | `src/agro_runtime/models.py` |
| 工作区管理请求 | `src/agro_runtime/workspace_models.py` |
| ROS 2 任务及字段映射 | `src/agro_runtime/ros_tasks.py` |
| 端口兼容与语义字段 | `src/agro_runtime/data_contracts.py` |
| TaskStart、TaskManifest | `src/agro_runtime/tasks.py` |
| 行为树编辑与发布请求 | `src/agro_runtime/tree_models.py` |

`schema.json` 的 `$defs` 包含执行、任务与工作区管理共享入口模型及依赖类型，协议兼容性字段为 `agro.capabilities.v1`

## 静态入口

```bash
python -m pip install -e .
agroctl package validate contracts/examples/tomato_mock.package.yaml
agroctl system validate contracts/examples/tomato_mock.system.yaml
python contracts/export_schema.py
```

包和系统描述支持 JSON 或 YAML，系统 `packages` 中的相对路径以系统文件所在目录为基准，成功退出码为 0，校验失败为 1，命令语法错误为 2

输出使用 JSON，错误包含 `path`、`code`、`reason`，路径形如 `$.capabilities[0].parameters.speed.unit`

## 声明标识、参数与角色

| 字段 | 规则 |
| --- | --- |
| 实例、角色、字段与执行标识 | 小写字母开头，后续使用小写字母、数字和下划线 |
| 能力标识 | 至少两个以点分隔的同规则片段，如 `manipulation.move_to_pose` |
| 资源、坐标系、时间域 | 支持点分隔名称，如 `arm.motion` |
| 资源访问 | 明确声明 `shared` 或 `exclusive` |
| `required_roles` | 声明当前系统所需角色 |
| `roles` | 绑定能力和后端实例，声明预期输入输出，字段集合、类型、单位、范围、坐标系与时间域需兼容 |

静态参数支持 string、integer、number、boolean 和 json，输入输出业务数据还支持 stamped_pose、target_list 与 pick_result

数值声明单位，无量纲使用 `1`，默认值按相同类型、范围与可选值规则校验，`required` 参数缺失且没有默认值时拒绝请求

`apply_policy` 可声明 immediate、idle 或 restart 策略，系统配置统一在停止态应用

位姿包含目标 ID、位置、xyzw 单位四元数、坐标系、时间戳与时间域，位置使用 m，描述声明 `max_age_s`，校验时调用者提供同域的 `now` 与 `clock_domain`

模型拒绝未知字段，自定义展示信息放入 `extensions`，其中 `extensions.ros_type` 与 `extensions.ros_shape` 是参与执行校验的 ROS 字段类型和结构声明

## ROS 2 任务与数据绑定

接口类型来自机器人所选子系统工作区中的离线定义和依赖快照，接口文件描述消息结构，实际 Topic、Service 或 Action 通信名称独立配置，动态名称由开发者确认

| 任务字段 | 映射方向 |
| --- | --- |
| `inputs`、`outputs` | 端口名对应数据契约 |
| `input_bindings` | 消息字段路径指向输入端口，执行时将端口值写入该消息字段 |
| `output_bindings` | 输出端口指向结果字段路径，执行时从该字段提取端口值 |

完整消息使用 `$` 路径，字段结构、数组边界和实际值均需通过校验

端口连接按方向比较类型、单位、坐标系、时间域、范围、可选值和 ROS 字段结构，名称标识端口，兼容性由契约决定，坐标或单位转换通过显式任务完成

JSON 消息可通过 `frame_path` 和 `stamp_path` 声明实际坐标系与采样时间字段，运行时按对应时间域确认有效性，HSM 流程变量独立记录写入时间，原始采样时间随数据保留

接口快照可离线编辑，执行时加载任务选定工作区的类型支持，外部接口模式跳过提供模块的自动启动，保留数据契约、控制授权和停止核对

## 注册与授权

| 操作 | 效果 |
| --- | --- |
| `load_package(path)` | 读取并校验描述，返回 PackageDescriptor |
| `Registry.register` | 注册描述，重复包或能力标识导致整次注册失败 |
| `Registry.enable(package_id, allowed_entrypoints=...)` | 记录显式允许的 module:function 入口，模块加载留给执行器 |
| `disable` | 取消启用并保留已注册描述 |
| `bind_system` | 校验系统绑定，可使用尚未启用的描述 |

注册后的描述默认未启用，ExecutionEngine 根据显式允许的入口加载适配器，执行能力还需有效控制授权与后端就绪

## 请求与结果

| 校验入口 | 输入与返回值 |
| --- | --- |
| `validate_request(request, bound, now=..., clock_domain=...)` | 校验输入与参数，补齐合法默认值，返回 ExecutionRequest |
| `validate_snapshot(snapshot, capability=None, now=..., clock_domain=...)` | 校验 OperationSnapshot，提供能力描述时进一步检查反馈与结果输出 |

控制授权使用结构化 ControlToken，契约入口校验其结构，ControlManager 与最终设备网关确认实际有效性

操作状态为 ACCEPTED、RUNNING、CANCELING、SUCCEEDED、FAILED、CANCELED、UNKNOWN，停止状态独立使用 CONFIRMED、UNCONFIRMED、NOT_APPLICABLE

| 结果或字段 | 约束 |
| --- | --- |
| SUCCEEDED | 必须有结果 |
| FAILED、UNKNOWN | 必须有原因 |
| UNKNOWN | 保留核对入口，禁止标记为可直接重试 |
| CANCELED | 停止仍适用时，需先确认停止 |
| `cancel_requested`、`cancel_accepted` | 分别记录取消请求和后端接受，停止确认另由 `stop_state` 表达 |
| 反馈 `timestamp`、`clock_domain` | 携带反馈采样时间与时间域 |

## 行为树发布与输出契约

共享 Schema 导出 TreeDocument、TreeDefinition、TreeNode、PortBinding、LayoutDocument、Diagnostic 及草稿、提取、校验与发布请求，子树端口复用 TypeDescriptor，任务输入复用 ParameterDescriptor

发布以标准 BehaviorTree.CPP XML 为执行定义，布局和显示名独立保存，Agent 冻结模型摘要、XML、系统、清单、资产、ROS 2 任务定义、软件来源和真实实例映射，TaskStart 与 TaskManifest 还声明任务参数、标定引用和有限候选策略

包含能力节点的定义需匹配有效系统快照，纯 ROS 2 行为树可在独立模式执行，工程与运行条件见[系统架构](../docs/architecture.md)

主树 OUTPUT 端口定义外部可见输出，执行器在整树成功后按声明读取根黑板，TaskManager 在成功且停止确认后保存该输出，HSM 再按阶段绑定更新流程变量，内部操作结果保留在台账，详细规则见[根树输出边界](../task_engine/README.md#根树输出边界)

发布定义保持不可变，运行输入按冻结契约校验，API 与 CLI 使用相同服务端策略，HSM 还会检查流程变量在所有可达路径上的来源，并在实际使用时核对数据

## 数据样例

| 样例 | 内容与使用条件 |
| --- | --- |
| [move.request.json](examples/move.request.json) | 单机单调时钟域位姿请求，校验上下文使用 `now=100.5` 与 `clock_domain=monotonic_host` |
| [unknown.operation.json](examples/unknown.operation.json) | 分别表达结果未知和停止未确认 |
| [targets.json](examples/targets.json) | StampedPose 数组，每项沿用位姿的单位、坐标系、时间域和新鲜度校验，列表级 choices 比较整个列表 |
| [pick.result.json](examples/pick.result.json) | 单果未知结果，failed 与 unknown 必须携带 reason |
| [bt.registry.json](examples/bt.registry.json) | 行为树离线注册样例，执行器用法见[行为树执行器](../task_engine/README.md) |

能力接入见[模拟适配器](../adapters/mock/README.md)，任务组织见[番茄采摘示例](../examples/tomato_picker/README.md)
