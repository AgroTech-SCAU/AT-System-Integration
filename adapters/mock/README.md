# 异步模拟适配器

模块名为 `agro_mock`，安装时包含 `package.yaml` 接入描述，通过 `agro_mock:create_adapter` 显式加载

## 接入方式

先用 `load_package` 注册 `adapters/mock/package.yaml`，再通过 `bind_system` 将角色绑定到该包提供的后端实例

```python
from agro_runtime.execution import ExecutionEngine

engine = ExecutionEngine(bound, registry)
adapter = engine.enable_adapter(
    backend_instance,
    allowed_entrypoints={'agro_mock:create_adapter'},
)
operation_id = await engine.submit(request)
snapshot = engine.get_operation(operation_id)
cancel_snapshot = engine.cancel(operation_id)
await engine.aclose()
```

上述片段在异步上下文中使用，`bound`、`registry`、`backend_instance` 和 `request` 来自调用方已校验的系统与请求

描述导入只读取数据，`enable_adapter` 检查入口允许列表后才导入模块并创建实例，`submit` 在后端本地接纳请求后返回 operation_id，后续执行由异步任务完成

`accept` 必须是无副作用的非阻塞本地接纳入口，耗时通信和动作在 `run` 中执行，执行句柄还提供异步 `request_cancel` 与 `wait_stopped`

## 状态与超时

执行经过 ACCEPTED、RUNNING 和结束状态，`get_operation` 返回独立副本，客户端修改快照不影响执行器

`cancel_requested` 表示调用方已请求取消，`cancel_accepted` 表示后端已接受取消，`stop_state` 单独描述实际停止确认，取消入口立即返回当前快照

取消已完成动作保留原结果，取消过程中到达的完成结果也会保留，不将已完成结果改写为 CANCELED

执行超时触发取消追踪，取消超时进入 UNKNOWN 与 UNCONFIRMED，迟到的停止确认仅更新 stop_state，结果继续保持 UNKNOWN 供后续核对

反馈携带 timestamp 和 clock_domain，过期或异域反馈触发受控取消，位姿在产生模拟副作用前再次检查新鲜度

执行期限采用能力 timeout_s，可用 execution_timeout_s 设置更短的上限，取消确认使用独立 cancel_timeout_s，反馈有效期使用 feedback_timeout_s

同一 request_id 与相同载荷返回同一执行实例，不同载荷复用标识返回 request_id_conflict，当前去重仅在执行器内存中保存，持久化由步骤 3 实现

不支持取消的能力返回 cancellation_unsupported，执行超时后记录 UNKNOWN，状态查询继续可用

执行器关闭会取消本地追踪协程，尚未确认结束的动作记录 UNKNOWN 与 UNCONFIRMED，系统停止与设备控制由后续步骤接入

## 能力与故障

模拟能力覆盖导航、单目标检测、相机到机械臂的固定平移、机械臂运动、夹持释放与结果验证

`MockWorld` 记录模拟位置、机械臂位姿、夹持目标与副作用信息，检测与变换保留目标标识、坐标系、时间域和观测时间，验证读取模拟夹持状态

`FaultPlan` 支持 startup_delay_s、duration_s、cancel_delay_s、fail_execution、stale_feedback、lose_result、cancel_unconfirmed 与 reject_request，参数由开发调用方显式设置

结果丢失进入 UNKNOWN 并禁止自动重试，故障不会触发第二次动作

`authorize(request, resources)` 可返回布尔值或异步布尔值，也可抛出结构化校验错误，执行器在接纳前与最终模拟副作用前调用该入口

默认未接入控制策略，步骤 3 将接入模式、控制令牌与资源门控，当前模拟不连接真实设备

## 验证记录

步骤 2 验证脚本在工作区外的临时目录执行，仓库只保留实现和验证结果，具体命令与结果记录于 `docs/plan.md`
