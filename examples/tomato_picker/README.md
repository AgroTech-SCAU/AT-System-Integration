# 番茄采摘模拟闭环

本例通过 CLI 和 BehaviorTree.CPP 执行导航、检测、坐标变换、接近、夹持、撤回、放置与作业记账，观测和动作由 MockWorld 模拟，相机到机械臂基座的变换使用固定 X 平移，不连接真实 ROS 子系统或硬件

这是仓库中的独立 CLI 开发示例；工作台新建机器人工程从空白配置开始

## 选择配置

| 配置 | 用途 |
| --- | --- |
| `system.yaml` | 单个 `robot` 后端，运行本页的完整采摘任务 |
| `system_four_backends.yaml` | 导航、视觉、机械臂和电控的角色分离参考 |

任务说明与标定资产都绑定后端 `robot`，直接改用四后端配置会触发资产身份校验；以下命令使用单后端配置

## 1 安装并启动 Agent

在仓库根目录执行，以下命令采用默认安装位置；使用自定义安装目录时调整 CLI 和执行器路径

默认管理端口为 8765；该端口已被其他 Agent 占用时，先正常关闭原 Agent，或给示例 Agent 指定其他 `--port`，并在所有客户端命令中设置对应的 `--endpoint`

```bash
./install.sh
.install/venv/bin/agroctl agent serve --config examples/tomato_picker/system.yaml \
  --state-dir /tmp/agro-tomato-state --task-engine .install/task-engine/agro-bt
```

Agent 保持在当前终端运行，示例状态保存在独立目录 `/tmp/agro-tomato-state` 中

## 2 启动系统并等待 READY

在另一个终端进入同一仓库根目录，提交系统启动请求并查询状态

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token system start
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token system status
```

启动请求异步处理，重复查询 system status，看到 READY 后再提交任务

## 3 提交采摘任务

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token task start examples/tomato_picker/tasks/harvest.xml \
  --request-id request_harvest
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token task list
```

保存返回的 task_run_id，后续查询和取消都使用该标识；关闭观察用的 CLI 连接后，任务仍由 Agent 执行

相同 request_id 与相同载荷返回同一个 task_run_id，载荷不同则拒绝；创建另一次运行时更换 `--request-id`，或省略该选项让 CLI 生成新标识

## 4 查看状态与结果

将 task_xxx 替换为返回的 task_run_id

```bash
TASK_RUN_ID=task_xxx
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token task status "$TASK_RUN_ID"
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token report "$TASK_RUN_ID"
```

| 任务状态 | 含义 |
| --- | --- |
| ACCEPTED / RUNNING | 已接受或正在执行 |
| CANCELING | 已请求取消，仍需等待停止结果 |
| SUCCEEDED | 行为树成功结束 |
| FAILED | 执行或业务条件失败，查看错误原因 |
| CANCELED | 任务已取消，同时核对 stop_confirmed |
| UNKNOWN | 结果待核对，按下一节处理 |

单果成功结果为 picked，要求夹持后核验成功、释放后确认正常放置，并具备对应的操作顺序与证据；不可达目标记录 skipped，空候选记录 empty_candidates，区域处理完成记录 area_completed

状态和报告分别保留树状态、节点路径、操作标识、反馈、业务原因与停止确认信息

## 5 按需取消与停止

需要中止正在执行的任务时，提交取消请求，再查询任务状态和 stop_confirmed

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token task cancel "$TASK_RUN_ID"
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token task status "$TASK_RUN_ID"
```

取消被接受只说明请求已收到，设备停止以停止确认信息为准；任务完成或中止后，停止模拟系统并观察状态

```bash
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token system stop
.install/venv/bin/agroctl --session-file /tmp/agro-tomato-state/session.token system status
```

出现 UNKNOWN 或停止未确认时，保留原状态目录，通过 task status 和 operation status 核对任务与操作台账；Agent 保留必要网关并阻止新的任务，CLI 没有通用的强制清除未知状态命令，需完成项目定义的设备核对

取消、接管或执行器异常退出会关闭任务派发并取消在途操作；Agent 重启后恢复台账，未完成任务保持 UNKNOWN，旧树与旧操作不会重放，已确认完成的目标会从后续模拟候选中过滤

## 参数与资产

package.yaml 声明模拟能力，system.yaml 绑定角色，tasks/harvest.xml 保存执行树，tasks/harvest.layout.json 保存独立布局占位数据

tasks/harvest.task.json 是 XML 的同名任务说明，保存参数契约、资产引用、候选界限、恢复次数和运行超时；当前最多处理 8 个目标，ForEachTarget 对每个目标只执行一次，自动恢复次数为 0

assets/camera_to_arm.json 保存适用设备、源目标坐标系、来源与模拟验证记录，任务说明保存其内容摘要；冻结任务时核对观测、变换与机械臂角色的设备身份及资产摘要

提交任务时可用 `--parameters` 指定 JSON 参数文件，用 `--config` 指定待核对的系统文件；参数按契约校验，指定系统须与 Agent 当前冻结系统一致，运行实例继续使用提交时冻结的内容

## 运行记录

状态目录保存 operations.db、tasks.db 和只读内容摘要快照，任务记录包含冻结 XML、策略参数、实际系统、资产内容和校验值、源码及执行器摘要、节点事件和单果结果

task status 返回本次运行快照、事件、关联操作和目标记录；单果记录包含目标 ID、观测、尝试次数、操作 ID、结果及失败或未知原因，控制令牌与会话密钥不写入快照和事件
