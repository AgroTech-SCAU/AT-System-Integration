# 异步模拟适配器

agro_mock 使用 MockWorld 提供导航、检测、坐标变换、机械臂运动、夹持释放与结果核验，供仓库开发使用，不连接真实 ROS 子系统或硬件

安装包包含接入描述 package.yaml，通过 agro_mock:create_adapter 加载；GUI 新建机器人从空白配置开始

## 选择接入描述

| 接入描述 | 能力范围 |
| --- | --- |
| `adapters/mock/package.yaml` | 六项基础能力，配合本目录的 system.yaml 使用 |
| `examples/tomato_picker/package.yaml` | 完整采摘模板所需的扩展能力 |

两份描述共用适配器实现，可用能力由所加载的接入描述决定；完整采摘流程见 [示例说明](../../examples/tomato_picker/README.md)

## 通过 Agent 运行

### 1 启动 Agent

在仓库根目录完成 `./install.sh`，以下命令使用默认安装目录；自定义安装目录时调整 CLI 路径

默认 API 为 http://127.0.0.1:8765；端口已被占用时先正常关闭原 Agent，或在启动命令中设置其他 `--port`，并在所有客户端命令中设置对应的 `--endpoint`

```bash
.install/venv/bin/agroctl agent serve --config adapters/mock/system.yaml --state-dir /tmp/agro-agent
```

Agent 在当前终端运行，状态目录保存会话文件、配置快照与 SQLite 台账；同一状态目录只允许一个 Agent

### 2 启动系统并等待 READY

在另一个终端进入同一仓库根目录，提交启动请求并查询状态

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token system start
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token system status
```

启动请求异步处理，重复查询 system status，看到 READY 后再获取控制令牌；重复 start 合并到同一个 system_run_id

### 3 获取令牌并提交操作

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token control take AUTO
```

准备 /tmp/request.json，按 ExecutionRequest 契约填写请求，并把 control take 返回的令牌放入 control 字段；位姿时间使用同一主机的 monotonic_host 时钟

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token operation submit /tmp/request.json
```

提交返回 ACCEPTED 或 RUNNING 后，使用返回的 operation_id 查询后续状态；关闭 CLI 连接后，操作仍由 Agent 执行

### 4 查看操作与系统快照

将下面命令中的 operation_id 替换为提交返回的标识

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token operation status operation_id
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token system snapshot
```

操作状态为 SUCCEEDED 时能力执行完成，stop_state 单独描述实际停止确认

### 5 按需取消并停止系统

需要中止操作时提交取消请求，再查询状态

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token operation cancel operation_id
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token operation status operation_id
```

cancel_requested 表示调用方已请求取消，cancel_accepted 表示后端已接受取消，实际停止以 stop_state 为准；已完成的动作保留原结果，取消期间到达的完成结果也会保留

完成后停止系统，重复查询直到 STOPPED；出现 STOP_UNCONFIRMED 时转到下面的故障处置

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token system stop
.install/venv/bin/agroctl --session-file /tmp/agro-agent/session.token system status
```

所有 API 使用会话文件中的 Bearer 密钥；保留会话文件的本地访问权限，避免输出或分享密钥，远程访问时自行建立 SSH 隧道到同一回环入口

## 故障与恢复

| 情况 | 处理方式 |
| --- | --- |
| 模块启动失败或崩溃 | 查看原因，停止系统后再启动，模块不会自动重启 |
| 执行超时 | 执行器请求取消并跟踪停止结果 |
| 取消超时或结果丢失 | 记录 UNKNOWN，停止未确认时保留 UNCONFIRMED 与资源隔离，不自动重试动作 |
| STOP_UNCONFIRMED | 保留 Agent 网关与诊断，完成项目定义的设备核对 |
| Agent 异常退出后重启 | 进入 RECOVERING，先 stop 核对原运行与本地进程状态 |

停止系统会先阻止新操作并撤销授权，再取消在途操作；正常退出信号同样等待停止确认，历史 UNKNOWN / UNCONFIRMED 需核对后才能解除资源隔离

迟到的停止确认会更新 stop_state 并解除对应资源隔离，UNKNOWN 结果继续保留供核对；重启读取已知请求和台账，不重发旧动作，外部设备的实际副作用仍需重新观测或人工核对

## 在代码中使用

在异步上下文中准备 state_directory、校验后的 bound 与 registry、backend_instance 和新鲜请求 request；先用 load_package 注册接入描述，再通过 bind_system 绑定角色

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
```

get_operation 返回独立快照；需要取消时调用 cancel，它会立即返回当前快照，后续继续查询停止结果

```python
cancel_snapshot = engine.cancel(operation_id)
```

最后关闭执行器，再关闭调用方持有的台账；尚未确认结束的动作会记录 UNKNOWN 与 UNCONFIRMED

```python
await engine.aclose()
records.close()
```

接入描述导入时只读取数据，enable_adapter 检查入口允许列表后导入模块并创建实例；submit 在后端本地接受请求后返回 operation_id，耗时执行由异步任务处理

适配器的 accept 应为无副作用、非阻塞的本地接纳入口，通信与动作在 run 中执行；执行句柄提供异步 request_cancel 与 wait_stopped

## 超时与请求去重

| 参数 | 作用 |
| --- | --- |
| 能力 timeout_s | 执行期限 |
| execution_timeout_s | 设置比能力期限更短的执行上限 |
| cancel_timeout_s | 取消确认期限 |
| feedback_timeout_s | 反馈有效期 |
| resource_timeout_s | 资源冲突时的有界等待时间，默认立即拒绝 |

反馈携带 timestamp 和 clock_domain，过期或异域反馈触发受控取消，位姿在产生模拟副作用前再次检查新鲜度；不支持取消的能力返回 cancellation_unsupported，执行超时后记录 UNKNOWN，状态查询继续可用

相同 request_id 与相同载荷返回同一执行实例，不同载荷复用标识返回 request_id_conflict；请求意图、标识、目标和结果保存在 SQLite 台账中

执行器需要显式提供台账，使用文件路径保留重启去重与授权代次；:memory: 适合隔离运行，关闭后不保留这些记录

## 授权与资源

控制器初始化为 STANDBY，begin_task 检查前置条件后转 AUTO；直接使用 ExecutionEngine 时由调用方确认就绪，通过 Agent 时由 Runtime 管理模块和就绪检查

authorize(request, resources) 可以返回布尔值、异步布尔值或抛出结构化校验错误，执行器在接纳前与最终模拟副作用前调用该入口

模拟设备网关在 _produce 前校验 owner、control_epoch、过期时间、时间域和资源持有情况；人工接管先推进持久化代次，旧令牌失效

资源按完整集合获取，停止未确认时不会因令牌到期而释放；资源状态由单机中的一个执行器协调，多主机协调与真实设备控制由对应项目提供实现

急停独立于模式，set_estop(True) 锁存 FAULT 并撤销本地授权，存储失败时仍阻止动作；设备确认解除急停后，调用 clear_fault 回到 STANDBY

## 模块与原生配置

模拟模块由本地进程组管理，Agent 中的适配器与控制网关执行能力；模块启动就绪后处于 STANDBY，control take AUTO 才授予任务控制权

接入包 runtime 声明 manager、target、dependencies、argv、start_timeout_s 和 stop_timeout_s，后端实例可覆盖 runtime；依赖名称引用 backend instance_id

systemd 管理指定 unit，ros_launch 管理 launch 根进程及进程组，组内节点由 launch 启动；本地模块保存 PID、启动时间、主机启动身份与实际命令，根进程继承管理锁，身份不符或旧进程仍持锁时拒绝重复启动，停止时跳过身份变化后的 PID

通过 `POST /system/readiness` 检查 process、interface、data 和 authorization；后端可向 Runtime 注入按能力与阶段检查的 readiness_probe，能力有数据前置条件但未提供检查时返回 data_check_required

native_config 与框架 config 分开管理，接入包需提供 native_validators 校验器；应用后生成只读冻结 JSON 文件，快照保存实际校验内容，修改原始 YAML、原生配置或返回的快照不会改变运行配置

JSON 也可作为 YAML 输入，本地或 launch 的 argv 通过 `{native_config}` 引用冻结文件；systemd 后端需通过 native_appliers 确认已应用冻结配置，否则启动返回 native_apply_required

## 模拟状态与故障参数

MockWorld 保存模拟位置、机械臂位姿、夹持目标和副作用信息，检测与变换保留目标标识、坐标系、时间域及观测时间，核验读取模拟夹持状态

开发调用方通过 FaultPlan 设置 startup_delay_s、duration_s、cancel_delay_s、fail_execution、stale_feedback、lose_result、cancel_unconfirmed 和 reject_request
