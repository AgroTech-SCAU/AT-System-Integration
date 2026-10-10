# 番茄采摘模拟闭环

通过统一 CLI 和真实 BehaviorTree.CPP 执行导航、检测、坐标变换、可达性检查、接近、夹持、撤回、采摘验证、放置、释放、放置验证和作业记账

本案例只使用框架内模拟后端，运行模块由 Agent 管理本地进程组，设备动作通过已有授权、资源门控与操作台账执行

## 开始与观察

先在仓库根目录安装 Python 包并构建执行器，构建目录可位于工作区外

```bash
python -m pip install -e .
cmake -S task_engine -B /tmp/agro-task-engine
cmake --build /tmp/agro-task-engine -j2
agroctl agent serve --config examples/tomato_picker/system.yaml \
  --state-dir /tmp/agro-tomato-state --task-engine /tmp/agro-task-engine/agro-bt
```

在另一个终端执行，系统启动为异步接受，查询到 READY 后再开始任务

```bash
agroctl --session-file /tmp/agro-tomato-state/session.token system start examples/tomato_picker/system.yaml
agroctl --session-file /tmp/agro-tomato-state/session.token system status
agroctl --session-file /tmp/agro-tomato-state/session.token task start examples/tomato_picker/tasks/harvest.xml \
  --request-id request_harvest
agroctl --session-file /tmp/agro-tomato-state/session.token task list
agroctl --session-file /tmp/agro-tomato-state/session.token task status <task_run_id>
agroctl --session-file /tmp/agro-tomato-state/session.token task cancel <task_run_id>
agroctl --session-file /tmp/agro-tomato-state/session.token system stop
```

任务开始后由 Agent 持有会话，退出观察 CLI 不取消任务，相同 request_id 与载荷返回同一个 task_run_id，不读取修改后的草稿重新执行，载荷不同则拒绝

任务状态包含 ACCEPTED、RUNNING、CANCELING、SUCCEEDED、FAILED、CANCELED 和 UNKNOWN，树状态、节点路径、操作标识、反馈、业务原因与 stop_confirmed 分开展示，取消接受不表示设备已经停止

## 模板与资产

`package.yaml` 描述本例的模拟能力，`system.yaml` 绑定角色，`tasks/harvest.xml` 为实际执行树，`tasks/harvest.layout.json` 只保存独立布局占位数据

`tasks/harvest.task.json` 是 XML 的同名任务说明，冻结参数、候选数量界限、恢复次数和运行超时，当前候选最多 8 个，自动恢复次数为 0，不直接重试任何物理动作

每次检测生成有限候选集，ForEachTarget 每个目标只执行一次，不可达目标记录 skipped，空列表记录 empty_candidates，正常处理完区域记录 area_completed，失败与未知保留各自原因

`assets/camera_to_arm.json` 保留适用设备、源目标坐标系、来源和验证记录，任务说明保存内容摘要，冻结前核对实际观测、变换和机械臂角色的设备身份，模拟变换只支持此已验证 X 平移

`--parameters` 可指定 JSON 参数文件，`--config` 可指定待核对的系统文件，参数按契约校验，系统草稿须与 Agent 当前冻结系统一致，修改文件不会更新运行实例

## 结果与停止

末端接受夹持命令不等于采摘成功，模板在撤回后检查持有状态，在收集位置释放后检查正常放置，全部条件成立才提交 picked，Agent 再核对已完成操作顺序与证据

取消、接管和执行器异常退出立即关闭任务派发并取消在途操作，停止未确认保留 UNKNOWN 和必要网关，结果未知禁止新任务绕过核对

Agent 重启恢复任务、操作、目标观测与尝试次数，未完成任务保留 UNKNOWN，不重新启动旧树或重放旧操作，已确认完成的目标从后续模拟候选中过滤

遇到 UNKNOWN 时通过 task status 和 operation status 核对台账与停止状态，当前保留待核对记录，不提供自动恢复或人工解除未知状态的完整工作流

## 运行记录

状态目录保存 `operations.db`、`tasks.db` 和只读内容摘要快照，任务记录包含冻结 XML、策略参数、实际系统、资产内容和校验值、源码及执行器摘要、节点事件和单果结果

`task status` 返回本次运行快照、事件、关联操作和目标记录，单果记录保留目标 ID、观测、尝试次数、操作 ID、成功或失败及未知原因，控制令牌与会话密钥不进入快照和事件
