# 异步模拟适配器

模块名为 `agro_mock`，安装时包含 `package.yaml` 接入描述，通过 `agro_mock:create_adapter` 显式加载

## 接入方式

先用 `load_package` 注册 `adapters/mock/package.yaml`，再通过 `bind_system` 将角色绑定到该包提供的后端实例

```python
from agro_runtime.execution import ExecutionEngine
from agro_runtime.records import OperationLedger

records = OperationLedger(state_directory / 'operations.db')
engine = ExecutionEngine(bound, registry, records=records)
adapter = engine.enable_adapter(
    backend_instance,
    allowed_entrypoints={'agro_mock:create_adapter'},
)
token = engine.control.begin_task('task_1')
request['control'] = token.model_dump(mode='json')
operation_id = await engine.submit(request)
snapshot = engine.get_operation(operation_id)
cancel_snapshot = engine.cancel(operation_id)
await engine.aclose()
records.close()
```

上述片段在异步上下文中使用，state_directory 是调用方准备的状态目录，bound、registry、backend_instance 和请求字典 request 来自已校验的系统与新鲜请求，Engine 关闭后由调用方关闭台账

描述导入只读取数据，`enable_adapter` 检查入口允许列表后才导入模块并创建实例，`submit` 在后端本地接纳请求后返回 operation_id，后续执行由异步任务完成

`accept` 必须是无副作用的非阻塞本地接纳入口，耗时通信和动作在 `run` 中执行，执行句柄还提供异步 `request_cancel` 与 `wait_stopped`

## 状态与超时

执行经过 ACCEPTED、RUNNING 和结束状态，`get_operation` 返回独立副本，客户端修改快照不影响执行器

`cancel_requested` 表示调用方已请求取消，`cancel_accepted` 表示后端已接受取消，`stop_state` 单独描述实际停止确认，取消入口立即返回当前快照

取消已完成动作保留原结果，取消过程中到达的完成结果也会保留，不将已完成结果改写为 CANCELED

执行超时触发取消追踪，取消超时进入 UNKNOWN 与 UNCONFIRMED，迟到的停止确认仅更新 stop_state，结果继续保持 UNKNOWN 供后续核对

反馈携带 timestamp 和 clock_domain，过期或异域反馈触发受控取消，位姿在产生模拟副作用前再次检查新鲜度

执行期限采用能力 timeout_s，可用 execution_timeout_s 设置更短的上限，取消确认使用独立 cancel_timeout_s，反馈有效期使用 feedback_timeout_s

同一 request_id 与相同载荷返回同一执行实例，不同载荷复用标识返回 request_id_conflict，已知请求的意图、标识、目标与结果保存在调用方配置的 SQLite 台账，重启恢复时在途操作转为 UNKNOWN 并隔离相应资源，不重发动作

不支持取消的能力返回 cancellation_unsupported，执行超时后记录 UNKNOWN，状态查询继续可用

执行器关闭会取消本地追踪协程，尚未确认结束的动作记录 UNKNOWN 与 UNCONFIRMED，系统停止与设备控制由后续步骤接入

## 能力与故障

模拟能力覆盖导航、单目标检测、相机到机械臂的固定平移、机械臂运动、夹持释放与结果验证

`MockWorld` 记录模拟位置、机械臂位姿、夹持目标与副作用信息，检测与变换保留目标标识、坐标系、时间域和观测时间，验证读取模拟夹持状态

`FaultPlan` 支持 startup_delay_s、duration_s、cancel_delay_s、fail_execution、stale_feedback、lose_result、cancel_unconfirmed 与 reject_request，参数由开发调用方显式设置

结果丢失进入 UNKNOWN 并禁止自动重试，故障不会触发第二次动作

`authorize(request, resources)` 可返回布尔值或异步布尔值，也可抛出结构化校验错误，执行器在接纳前与最终模拟副作用前调用该入口

执行器默认使用强制模式、令牌与资源门控，控制器初始化为 STANDBY，begin_task 检查门控前置条件并转 AUTO，模块运行与就绪检查由步骤 4 接入

最终模拟设备网关在 _produce 前独立校验 owner、control_epoch、过期时间、时间域和资源持有情况，人工接管先推进持久化代次，旧令牌随后到达也不能产生副作用

资源全量尝试获取，资源冲突默认立即拒绝，可用 resource_timeout_s 配置有界等待，未确认停止的资源不会因令牌到期而释放，迟到的停止确认会更新台账并解除对应隔离

急停独立于模式，set_estop(True) 先锁存 FAULT 并撤销本地授权，存储失败也维持阻止动作，解除必须由设备确认，解除后仍需 clear_fault 回到 STANDBY

执行器要求显式提供 SQLite 台账，文件路径用于持久化，显式 :memory: 只适合隔离验证，不具备重启去重或授权代次持久化能力

台账保证已知请求去重与重启后不自动重放，外部设备副作用是否已经发生仍可能需要重新观测或人工核对，不承诺物理 exactly-once

当前门控为单机模拟实现，资源状态由一个执行器协调，生产服务生命周期、多主机协调与真实设备仍由后续步骤接入

## 验证记录

步骤 2 验证脚本在工作区外的临时目录执行，仓库只保留实现和验证结果，具体命令与结果记录于 `docs/plan.md`

## Agent 与统一 CLI

安装项目后，在一个终端运行 Agent，状态目录保存本地会话密钥、配置快照与 SQLite 台账

```bash
agroctl agent serve --config adapters/mock/system.yaml --state-dir /tmp/agro-agent
```

在另一个终端通过同一个管理 API 操作系统

```bash
agroctl --session-file /tmp/agro-agent/session.token system start
agroctl --session-file /tmp/agro-agent/session.token system status
agroctl --session-file /tmp/agro-agent/session.token system snapshot
agroctl --session-file /tmp/agro-agent/session.token control take AUTO
agroctl --session-file /tmp/agro-agent/session.token operation submit /tmp/request.json
agroctl --session-file /tmp/agro-agent/session.token operation status operation_id
agroctl --session-file /tmp/agro-agent/session.token operation cancel operation_id
agroctl --session-file /tmp/agro-agent/session.token system stop
```

`request.json` 使用共享 ExecutionRequest 契约，control 字段填入 control take 返回的令牌，位姿使用同一主机 monotonic_host 时钟，新鲜性仍由执行入口与设备网关校验

默认 API 为 `http://127.0.0.1:8765`，可在命令前加 `--endpoint` 指定另一个回环端口，所有 API 都需要会话文件中的 Bearer 密钥，不应输出或分享密钥，远程客户端未来通过 SSH 隧道访问同一回环入口

system start 与 system stop 返回 accepted 后通过 status 观察完成状态，operation submit 返回 ACCEPTED 或 RUNNING 表示已接受，只有后续状态为 SUCCEEDED 才表示能力完成，关闭 CLI 连接不会自动取消任务

模拟运行模块由本地进程组管理，Agent 中的适配器与控制网关负责能力执行，模块正常启动后处于 STANDBY，control take AUTO 才开始任务授权，重复 start 合并到同一个 system_run_id

接入包 runtime 定义 manager、target、dependencies、argv、start_timeout_s 与 stop_timeout_s，实例可通过 runtime 覆盖，依赖名称引用 backend instance_id，systemd 仅管理目标 unit，ros_launch 仅管理 launch 根进程及其组，组内节点不再由 Agent 单独启动

同一状态目录只允许一个 Agent，启动失败或模块崩溃不自动重启，先查看原因再 stop 并 start，历史操作仍按 request_id 去重，不重发设备动作

按能力检查使用 `POST /system/readiness`，分别返回 process、interface、data、authorization，后端可向 Runtime 注入按能力与阶段检查的 readiness_probe，未提供数据检查的能力前置条件会显示 data_check_required

后端 native_config 引用独立于框架 config，只有对应接入包提供 native_validators 校验器时才允许应用，快照保存实际校验内容，编辑原始 YAML、原生配置或返回的快照不会改变本次运行配置

停止系统会立即阻止新操作并撤销授权，再取消在途操作，停止未确认时显示 STOP_UNCONFIRMED 并保留网关和诊断进程，Agent 的正常退出信号同样等待停止确认，不能把这种状态当作已安全退出

异常退出后 Agent 进入 RECOVERING，读取原运行 ID、操作台账和本地进程身份，不能直接开始任务，先 stop 核对停止状态，历史 UNKNOWN/UNCONFIRMED 会继续保持 STOP_UNCONFIRMED，需要项目定义的设备核对才能解除资源隔离

本地模块持久化 PID、启动时间、主机启动身份与实际命令，并让进程组根继承管理锁，身份不符或旧进程仍持锁时拒绝重复启动，停止不向身份变化后的 PID 发送信号

原生配置应用使用只读冻结 JSON 文件，JSON 同时可作为 YAML 输入，本地或 launch 启动 argv 通过 `{native_config}` 引用该文件，systemd 后端必须提供 native_appliers 并明确确认冻结配置应用成功，否则启动显示 native_apply_required，不把原文件引用当作已经应用
