# 行为树能力桥

实际 BehaviorTree.CPP 加载 XML，能力节点来自 Agent 的 `/system/snapshot`，执行沿用管理核心的授权、资源门控和操作台账

## 构建与静态校验

需要 C++17 编译器、CMake、libcurl 开发包，首次配置从官方源码归档获取固定依赖并核对 SHA256，离线环境可设置 `FETCHCONTENT_SOURCE_DIR_BEHAVIORTREE_CPP` 指向已下载源码

```bash
cmake -S task_engine -B /tmp/agro-task-engine
cmake --build /tmp/agro-task-engine -j2
/tmp/agro-task-engine/agro-bt --xml task_engine/examples/bridge.xml \
  --registry contracts/examples/bt.registry.json --validate-only \
  --models /tmp/agro-node-models.xml
```

`bt.registry.json` 是模拟包与系统描述的离线注册样例，运行时从 Agent 读取当前冻结快照，`--registry` 在运行模式下用于精确比较快照，不能直接拿离线样例代替实际快照

## 运行

先按模拟接入说明启动 Agent 和系统并获取 AUTO 控制令牌，将令牌响应保存为 JSON，将本地会话密钥保存到权限受限文件

```bash
/tmp/agro-task-engine/agro-bt --xml task_engine/examples/bridge.xml \
  --endpoint http://127.0.0.1:8765 \
  --session-file /tmp/session.token --control-file /tmp/control.json \
  --task-run-id task_observe --state-file /tmp/task-observe.json
```

示例仅观察目标并展示 Sequence、Fallback、SubTree 和类型转换，完整番茄采摘与 Agent 任务会话见 `examples/tomato_picker/README.md`

标准输出为最终 JSON，诊断输出到标准错误，成功退出码为 0，校验失败、执行失败、超时或取消退出码为 1，SIGINT、SIGTERM 和 `--cancel-after-ms` 请求停止，`--timeout-ms` 默认 30000

## 端口与数据

能力 `navigation.move_to_waypoint` 注册为 `Capability_navigation_move_to_waypoint`，每个实例提供唯一 `node_id`，并且只指定 `role` 或 `backend_instance` 之一

输入端口沿用字段名，参数使用 `param_` 前缀，输出使用 `out_` 前缀，参数优先级为 XML、角色配置、能力默认值，节点模型可通过 `--models` 导出

字符串与布尔值使用原生类型，数值使用带 `value` 和 `unit` 的 Quantity 或 IntegerQuantity，整数拒绝小数和超出有符号整数范围的数据，位姿、目标列表和单果结果分别使用 StampedPose、TargetList、PickResult

XML 对象与列表字面量加 `json:` 前缀并转义引号，避免与 `{blackboard_key}` 引用混淆，`--blackboard` 接受按键组织的 `{type,value,unit}` 初始数据

加载前拒绝未知节点、缺失绑定、重复节点标识、无来源输入、类型冲突、单位与坐标系冲突，动态观测有效期由 Python 请求入口按同域单调时钟检查

转换节点为 TargetsFromPose、SelectTarget 和 MakePickResult，条件节点为 HasTarget 和 PickSucceeded，单果结果只是业务数据，MakePickResult 不执行设备动作或记账

## 停止与未知结果

tick 只读工作队列和内存快照，HTTP 在默认两个有界工作线程执行，最多 32 个待处理操作，每次网络请求超时 500 ms

halt 立即停止后续派发并移交取消追踪，停止超时独立为 2000 ms，CLI 等待追踪后输出报告，树的 IDLE 与操作的停止确认分别记录

提交超时、HTTP 服务错误、错误操作身份或非法响应保留 UNKNOWN 和原因，不重新提交，也不进入下一物理动作，后续停止确认可以更新 stop_state，但不会把未知结果改写成成功

`operations[].operation_id` 只记录 Agent 返回的真实操作标识，尚未获得标识时为空，客户端排队状态不表示 Agent 已接纳，客户端合成快照使用 `local_<request_id>` 标识，不可拿它调用 Agent 操作接口，UNKNOWN/UNCONFIRMED 需要通过 Agent 台账核对

测试源码只在工作区外临时目录，CMake 的 `AGRO_CPP_TEST_SOURCE` 和 `AGRO_CPP_TEST_REGISTRY` 用于挂接临时验证，不随仓库交付测试文件

任务模板扩展 ForEachTarget 与 IsTrue，前者在最多 8 个互异目标上执行子树，空列表成功结束，子树失败立即中止，实时节点与操作报告通过原子替换状态文件交给 Agent

## 编辑模型与实例观察

`--describe-nodes` 搭配 `--registry` 导出实际工厂注册的 JSON 节点模型，包含端口方向、类型、缺省值、子节点数量及当前允许编辑的节点，描述与静态校验不调用能力或获取控制权

```bash
.install/task-engine/agro-bt --registry contracts/examples/bt.registry.json --describe-nodes
```

发布服务使用 `--validate-only --instance-ids` 对标准 XML 和初始 Blackboard 做实际加载校验，返回真实节点路径、UID 与能力操作标识，执行同样使用 `--instance-ids`，通过调用路径区分同一子树的不同实例

默认执行保留原 node_id 语义，启用实例标识时能力操作标识由实际调用路径生成，用户标签不作为可信业务阶段，阶段映射由服务端验证结构后生成并冻结

执行报告包含单调递增 event_sequence 和最近 512 条 node_events，每条记录实际节点路径、前后状态与编辑标识，完整节点状态与事件共同用于重连观察，设备停止继续使用独立 stop_confirmed
