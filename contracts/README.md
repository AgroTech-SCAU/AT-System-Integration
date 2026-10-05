# 接入与执行契约

权威模型位于 `src/agro_runtime/models.py`，`schema.json` 的 `$defs` 包含六个共享入口模型与依赖类型，协议兼容性字段为 `agro.capabilities.v1`

JSON Schema 描述字段结构，单位要求、范围关系、默认值合法性、角色兼容性与运行数据新鲜度还需要 Python 校验入口执行语义校验，后续跨语言接入使用这里的相同样例

## 静态入口

```bash
python -m pip install -e .
agroctl package validate contracts/examples/tomato_mock.package.yaml
agroctl system validate contracts/examples/tomato_mock.system.yaml
python contracts/export_schema.py
```

包和系统描述支持 JSON 或 YAML，系统 `packages` 中的相对路径以系统文件所在目录为基准，成功退出码为 0，校验失败为 1，命令语法错误为 2

输出使用 JSON，错误包含 `path`、`code`、`reason`，路径形如 `$.capabilities[0].parameters.speed.unit`

## 标识与模型

- 实例、角色、字段与执行标识使用小写字母开头，后续只允许小写字母、数字和下划线
- 能力标识至少包含两个以点分隔的同规则片段，如 `manipulation.move_to_pose`
- 资源、坐标系和时间域支持点分隔名称，如 `arm.motion`，资源访问明确为 `shared` 或 `exclusive`
- `required_roles` 声明当前系统所需角色，`roles` 绑定能力和后端实例，并声明预期输入输出，字段集合、类型、单位、范围、坐标系与时间域必须兼容
- 静态参数支持 string、integer、number 和 boolean，stamped_pose 只用于输入输出观测，数值声明单位，无量纲使用 `1`，默认值同样按类型、范围与可选值校验
- `required` 参数缺失且没有默认值时拒绝请求，`apply_policy` 为 immediate、idle 或 restart，仅声明策略，当前步骤不执行配置应用
- 位姿包含目标 ID、位置、xyzw 单位四元数、坐标系、时间戳与时间域，位置使用 m，描述声明 `max_age_s`，校验时调用者提供同域的 `now` 与 `clock_domain`
- 未知字段拒绝，展示扩展放入 `extensions` 对象，扩展值不参与执行参数解释

## 注册与授权

`load_package(path)` 仅读取、校验并返回 PackageDescriptor，`Registry.register` 拒绝重复包与重复能力标识，失败不部分注册

注册后描述可见，但默认未启用，`Registry.enable(package_id, allowed_entrypoints=...)` 仅记录显式允许的 module:function 入口，既不导入也不调用模块，`disable` 保留已注册描述

Registry 提供静态启用状态，ExecutionEngine 在显式允许入口后加载适配器，`bind_system` 可校验尚未启用的描述，不能据此直接执行能力

## 请求与结果

`validate_request(request, bound, now=..., clock_domain=...)` 校验请求输入与参数，补齐合法默认值并返回 ExecutionRequest，控制授权是结构化 ControlToken，此步骤只校验结构，设备侧有效性由步骤 3 实现

`validate_snapshot(snapshot, capability=None, now=..., clock_domain=...)` 校验 OperationSnapshot，提供能力描述时进一步检查反馈数据和结果输出

操作状态包含 ACCEPTED、RUNNING、CANCELING、SUCCEEDED、FAILED、CANCELED、UNKNOWN，停止状态独立为 CONFIRMED、UNCONFIRMED、NOT_APPLICABLE

SUCCEEDED 必须有结果，FAILED 与 UNKNOWN 必须有原因，UNKNOWN 不允许标记可直接重试，停止仍适用且未确认时不能记录 CANCELED

`examples/move.request.json` 是当前单机单调时钟域位姿请求，验证上下文使用 `now=100.5` 与 `clock_domain=monotonic_host`，`examples/unknown.operation.json` 展示结果未知与停止未确认的独立表达

异步执行器复用上述模型，反馈可携带 timestamp 与 clock_domain，快照新增 cancel_requested 与 cancel_accepted，分别记录取消请求和后端接受，停止确认仍使用独立 stop_state

模拟能力描述和接入说明位于 `adapters/mock/`，开发验证脚本仅在工作区外临时目录执行，仓库保留验证结果
