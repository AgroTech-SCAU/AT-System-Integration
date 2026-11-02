# 行为树执行器

行为树执行器使用 BehaviorTree.CPP 加载标准 XML，由 TaskManager 作为子进程启动，发布服务负责校验定义，运行台负责准备所需工作区环境和启动模块

本文说明执行器构建、节点端口、根树输出和观察接口，工作流设计见[通用任务架构](../docs/task-architecture.md)

## 注册节点与选择运行模式

| 节点来源 | 注册表来源 | 执行条件 |
| --- | --- | --- |
| 能力节点 `Capability_` | Agent 的 `/system/snapshot` | 能力系统配置已应用且系统就绪 |
| ROS 2 任务节点 `RosTask_` | 冻结注册表的 `ros_tasks` | 对应任务的执行环境和通信配置可用 |

空白机器人可在能力运行核心停止、实体安全保护已确认时执行由 ROS 2 任务和流程控制节点组成的树，两种模式均使用 Agent 的授权、资源门控、操作台账和停止确认

## 构建与静态校验

需要 C++17 编译器、CMake、libcurl 开发包，首次配置从官方源码归档获取固定依赖并核对 SHA256，离线环境可设置 `FETCHCONTENT_SOURCE_DIR_BEHAVIORTREE_CPP` 指向已下载源码

```bash
cmake -S task_engine -B /tmp/agro-task-engine
cmake --build /tmp/agro-task-engine -j2
/tmp/agro-task-engine/agro-bt --xml task_engine/examples/bridge.xml \
  --registry contracts/examples/bt.registry.json --validate-only \
  --models /tmp/agro-node-models.xml
```

`bt.registry.json` 提供模拟包与系统描述的离线注册样例，运行模式从 Agent 读取当前冻结快照，指定 `--registry` 时会精确比较快照，因此运行时应传入对应的冻结注册表

## 直接运行执行器

下面的能力桥示例需要先按[模拟接入说明](../adapters/mock/README.md)启动 Agent 和系统并获取 AUTO 控制令牌，将令牌响应保存为 JSON，将本地会话密钥保存到权限受限文件

```bash
/tmp/agro-task-engine/agro-bt --xml task_engine/examples/bridge.xml \
  --endpoint http://127.0.0.1:8765 \
  --session-file /tmp/session.token --control-file /tmp/control.json \
  --task-run-id task_observe --state-file /tmp/task-observe.json
```

示例观察目标并展示 Sequence、Fallback、SubTree 和类型转换，完整番茄采摘与 Agent 任务会话见[番茄采摘示例](../examples/tomato_picker/README.md)

标准输出为最终 JSON，诊断输出到标准错误，成功退出码为 0，校验失败、执行失败、超时或取消退出码为 1，SIGINT、SIGTERM 和 `--cancel-after-ms` 请求停止，`--timeout-ms` 默认 30000

## 定义端口与数据

能力 `navigation.move_to_waypoint` 注册为 `Capability_navigation_move_to_waypoint`，每个实例提供唯一 `node_id`，并且只指定 `role` 或 `backend_instance` 之一

| 端口 | 命名与取值 |
| --- | --- |
| 输入 | 沿用字段名 |
| 参数 | 使用 `param_` 前缀，取值优先级为 XML、角色配置、能力默认值 |
| 输出 | 使用 `out_` 前缀，绑定到可写黑板变量 |

ROS 2 任务节点注册为 `RosTask_<任务标识>`，沿用相同输入输出命名规则，实际通信在任务指定的隔离工作区环境中执行，节点模型可通过 `--models` 导出

| 契约数据 | 执行器类型 |
| --- | --- |
| 字符串、布尔值 | 原生类型 |
| 数值 | 带 `value` 和 `unit` 的 Quantity |
| 整数 | 带 `value` 和 `unit` 的 IntegerQuantity，拒绝小数及超出有符号整数范围的数据 |
| 位姿 | StampedPose |
| 目标列表 | TargetList |
| 单果结果 | PickResult |
| 通用 JSON | JsonValue |

XML 对象与列表字面量加 `json:` 前缀并转义引号，黑板引用使用 `{blackboard_key}`，`--blackboard` 接受按键组织的 `{type,value,unit}` 初始数据

加载前拒绝未知节点、缺失绑定、重复节点标识、无来源输入、类型冲突、单位与坐标系冲突，动态观测有效期由 Python 请求入口按同域单调时钟检查

转换节点为 TargetsFromPose、SelectTarget 和 MakePickResult，条件节点为 HasTarget 和 PickSucceeded，MakePickResult 生成单果业务数据，设备动作与记账由对应能力执行

ForEachTarget 在最多 8 个互异目标上执行子树，空列表成功结束，子树失败立即中止，任务模板还提供 IsTrue 条件节点

## 根树输出边界

根树输出声明在 `TreeNodesModel` 中对应主树的 `SubTree` 模型内，使用 `output_port` 命名并通过 `agro_contract` 元数据保存数据契约，名称对应根黑板键

嵌套子树的端口重映射由 BehaviorTree.CPP 完成，整树返回 SUCCESS 后，执行器从根黑板读取已声明输出，按实际类型、单位和契约校验后写入最终报告的 `output` 对象

例如内部任务的 `out_result="{leaf_pose}"` 可经子树映射到根黑板 `target_pose`，外部流程读取根树声明的 `target_pose`，内部 `result` 保留在操作结果中

| 情形 | 树级输出 |
| --- | --- |
| 整树成功且停止确认 | TaskManager 保存最终 `output`，HSM 根据自身输出绑定更新流程变量 |
| 根树未声明输出 | 返回空对象 |
| 声明输出缺值或不符合契约 | 执行失败 |
| 失败、取消或停止未确认 | 成功输出不提交给外部流程 |

## 停止与未知结果

tick 通过工作队列和内存快照获取操作状态，HTTP 在默认两个有界工作线程执行，最多 32 个待处理操作，每次网络请求超时 500 ms

halt 立即停止后续派发并移交取消追踪，停止超时独立为 2000 ms，CLI 等待追踪后输出报告，树的 IDLE 与操作的停止确认分别记录

提交超时、HTTP 服务错误、错误操作身份或非法响应记录为 UNKNOWN 并保留原因，后续物理动作和自动重新提交停止，迟到的停止确认只更新 stop_state，UNKNOWN 结果保留供核对

| 标识或状态 | 使用方式 |
| --- | --- |
| `operations[].operation_id` | Agent 返回的真实操作标识，尚未获得时为空 |
| `local_<request_id>` | 客户端合成快照标识，仅用于本地观察，调用 Agent 操作接口需使用真实操作标识 |
| 客户端排队 | 等待派发，是否接纳以 Agent 响应为准 |
| UNKNOWN / UNCONFIRMED | 通过 Agent 台账核对结果和设备停止状态 |

## 编辑模型与实例观察

`--describe-nodes` 搭配 `--registry` 导出实际工厂注册的 JSON 节点模型，包含端口方向、类型、缺省值、子节点数量及当前允许编辑的节点，描述与静态校验在离线状态完成，保持设备控制权不变

```bash
.install/task-engine/agro-bt --registry contracts/examples/bt.registry.json --describe-nodes
```

发布服务使用 `--validate-only --instance-ids` 对标准 XML 和初始 Blackboard 做实际加载校验，返回真实节点路径、UID 与能力操作标识，执行同样使用 `--instance-ids`，通过调用路径区分同一子树的不同实例

默认执行保留原 node_id 语义，启用实例标识时能力操作标识由实际调用路径生成，显示标签用于观察，业务阶段映射由服务端校验结构后生成并冻结

实时节点与操作报告通过原子替换状态文件交给 Agent，报告包含单调递增 event_sequence 和最近 512 条 node_events，每条记录实际节点路径、前后状态与编辑标识，完整节点状态与事件共同用于重连观察，设备停止继续使用独立 stop_confirmed
