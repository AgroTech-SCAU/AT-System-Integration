# 农业机器人系统集成框架实施计划

## 0 计划依据与使用方式

依据已确认的《农业机器人系统集成框架：架构蓝图》与 [KR-Skills/mini-step-plan](https://github.com/Kaede-Rei/KR-Skills/tree/main/mini-step-plan)

工程规模为 XL，采用完整阶段路线图加当前阶段详细计划，后续阶段到达入口条件后再展开，避免在接口尚未验证时预写大量实施细节

建议将本文件放入目标仓库 `docs/plan.md`，将架构蓝图放入 `docs/architecture.md`，执行时必须读取二者

当前未提供框架实现仓库，本计划中的目录、接口与命令是待实现约定，不是对已有源码的描述，也不代表已经验证通过

若目标仓库已有等价实现，读取后复用并记录对应关系，不为迎合本计划移动目录或重写实现

### 新增执行约束

测试与验证脚本只放在工作区外的临时目录，验证成功后不作为仓库交付，不新增或保留 `tests/` 源码，仓库只记录实际命令与结果

下文原有 tests 路径与测试文件名表达验证范围，执行时改用临时目录中的同名验证脚本，此约束优先于各步骤原先的测试文件交付要求


## 1 全工程阶段路线图

| 阶段 | 可独立验收的目标 | 主交付 | 进入下一阶段的条件 |
|---|---|---|---|
| P1 运行核心与模拟闭环 | CLI 配置并运行番茄采摘模拟任务 | 契约、注册表、模拟适配器、Agent、模式与门控、实际行为树执行器 | 导入、绑定、执行、取消、异常处理和运行快照全部通过 |
| P2 系统搭建 GUI | 不编辑 YAML 也能配置系统并执行模板任务 | 共享界面基础、生成式表单、后端绑定、配置差异、资产管理、运行页面 | GUI 与 CLI 操作同一核心，模拟闭环和配置生效规则通过 |
| P3 可视化任务编辑 | 在 GUI 编辑子树与数据绑定并执行 | 行为树画布、节点库、端口映射、XML 往返、静态校验、实时观察 | 保存加载保持执行语义，编辑草稿不改变运行实例 |
| P4 番茄机器人真机接入 | 四类真实后端协同完成采摘 | 视觉、导航、机械臂、电控接入包、标定入口、采摘模板 | 分系统验收与真实单果闭环通过，接管和停止行为确认 |
| P5 多主机部署与可追溯运行 | 换设备可部署，故障可追溯，离线回放隔离 | SSH 管理、多主机 Agent、安装向导、数据记录、回放、报告、有限回退 | x86_64 与 ARM64 分别验证，回放不会产生真机输出 |

P1 至 P5 都属于目标工程，后续阶段不计入当前阶段进度，也不放入 Later Optional

### P2 后续展开时必须覆盖

- 核对 SerialArm-Core GUI 的实际组件与许可，复用主题、导航、终端和表单，机械臂专用页作为项目扩展
- 系统搭建、模板任务配置和运行调试共用 P1 管理 API
- Schema 表单显示单位、范围、必填项、重启要求和校验原因
- 配置采用草稿、校验、差异、应用、实际结果的完整过程，多后端部分生效必须可见
- 标定资产记录设备身份、源目标坐标系、来源、校验值与验证记录
- 耗时操作显示正在执行、反馈和明确的结束结果，取消入口在等待期间可用
- 图像与点云采用专用数据通道，管理 API 只传必要元数据与流入口

### P3 后续展开时必须覆盖

- 行为树父子关系与数据端口映射分别编辑，节点顺序具有执行语义
- 支持框架注册的控制节点、动作节点、条件节点、子树与显式类型转换
- XML 是任务执行定义，画布布局另存，验证 XML 往返后行为等价
- 校验节点子节点数量、子树递归、类型、作用域、未绑定输入、资源冲突与能力兼容性
- 运行事件关联 node_id 与 operation_id，点击节点能查看反馈与原因
- Groot2 作为可选工具入口，不成为系统配置或任务执行的必需依赖

### P4 后续展开时必须覆盖

- 在各自接入步骤内读取真实后端代码，核对接口、反馈和停止机制，明确哪些需要用户提供设备或协议
- 机械臂接入 SerialArm-Core，保留原生 Profile 与控制器配置所有权，不固定自由度、基座或工具名称
- 视觉使用带目标 ID、坐标系、时间戳的位姿，通过有效标定变换后交给机械臂
- 导航就绪按能力与任务阶段判断，不把完成定位设为所有服务启动的统一条件
- 电控由主机网关适配 MCU 协议，命令发送成功不等于末端执行成功
- 真实后端也必须执行资源与控制权限检查，不能只依赖 Agent 内的模拟门控
- 单果流程覆盖接近、末端操作、撤回、结果验证、放置和作业台账更新
- 遮挡与不可达可恢复，通信故障与停止未确认中止，结果未知先重观测或人工确认

### P5 后续展开时必须覆盖

- 远程 GUI/CLI 通过 SSH 隧道连接管理 API，Agent 默认监听回环地址
- 每台主机独立管理本机进程，整机协调器汇总跨主机依赖与状态
- 跨主机故障和租约过期处理先在模拟环境验证，不能直接复用单进程资源锁声称已支持分布式控制
- 安装向导展示代码、依赖、配置、资产和数据的实际路径，区分开发与部署
- 部署可采用 Ansible，复杂依赖按组件选用容器，不建立首期容器集群
- 按项目配置 rosbag2/MCAP 等数据记录，建立报告脱敏、数据索引与保留规则
- 回退仅覆盖已验证的软件与配置，系统依赖不承诺无条件回退
- 离线回放禁用真机适配器加载与设备控制权获取，不以 GUI 隐藏按钮代替隔离

## 2 本次唯一目标

完成 P1，通过统一 CLI 和实际 BehaviorTree.CPP 执行器运行一个番茄采摘模拟闭环，证明能力接入、后端绑定、运行管理、取消、控制权限和结果记录能协同工作

## 3 本次明确不做

- 不开发 GUI、完整画布、Groot2 集成或远程桌面包装
- 不接真机、不修改 MCU 固件、不训练识别模型、不调整运动控制算法
- 不迁移 Atlas，不把 Atlas 作为对外项目示例
- 不建设多主机资源仲裁、插件市场、容器集群或云平台
- 不实现可靠暂停与断点恢复，不自动恢复未确认的执行动作
- 不新增当前闭环无关的 benchmark、长稳测试或研究实验
- 不修改 SerialArm-Core、导航、视觉等外部仓库，只使用框架内模拟后端
- 不主动扩散 README、CHANGELOG、其他计划和设计文档修改

## 4 当前已完成基线

已确认架构层面的选择

- BehaviorTree.CPP 作为默认任务引擎，整机模式独立管理
- 接入包同时描述能力、运行、配置与执行适配器
- GUI 分系统搭建、任务设计、运行调试三个工作区
- 首个对外完整案例为番茄采摘机器人
- 配置快照、结果未知、停止确认和设备侧控制权限属于运行契约

计划编写时尚无本框架的源码、构建、测试或运行证据，实际实施进度与验证证据见步骤记录和第 13 节

现有 SerialArm-Core 和其他项目仅作为后续接入候选，不将其已有功能计入框架实现进度

## 5 当前阶段完成标准

- [ ] 有效接入包能注册，非法描述与未授权适配器不能启用
- [ ] 能力角色能绑定到兼容后端，输入、坐标系、数据有效期与参数错误能够解释
- [ ] 系统启动进入待命，重复启动不产生第二份进程，当前阶段未满足的条件不会错误阻塞其他模块
- [ ] C++ BehaviorTree.CPP 执行器通过统一能力入口完成模拟单果采摘与放置
- [ ] 取消请求、后端取消接受与设备停止确认分别记录，未确认停止不会标为已取消完成
- [ ] 接管撤销旧控制权，旧请求被最终模拟设备网关拒绝
- [ ] 丢失结果进入 UNKNOWN，不盲目重试，不重复产生不可重复操作
- [ ] 运行期间编辑草稿不改变任务快照，重启不自动重放运动
- [ ] CLI 能查看任务、操作、阻塞原因与本次生效配置
- [ ] 最小记录保存来源、任务树、配置、资产校验值、事件与目标结果

## 6 目录与接口约定

### 6.1 建议修改范围

| 路径 | 职责 | 首次引入 |
|---|---|---|
| `pyproject.toml`、`src/agro_runtime/` | Python 管理核心与 CLI | 步骤 1 |
| `contracts/` | 接入包、系统配置、执行状态与任务数据契约 | 步骤 1 |
| `src/agro_runtime/registry.py` | 描述发现、校验、后端角色绑定 | 步骤 1 |
| `src/agro_runtime/execution.py`、`adapters/mock/` | 执行实例、异步适配、故障注入 | 步骤 2 |
| `src/agro_runtime/control.py`、`records.py` | 模式、资源、控制权、操作台账 | 步骤 3 |
| `src/agro_runtime/runtime.py`、`api.py`、`cli.py` | 进程管理、就绪、管理接口与命令 | 步骤 4 |
| `task_engine/` | C++ 行为树执行器与能力客户端 | 步骤 5 |
| `examples/tomato_picker/` | 模拟系统、资产和任务 XML | 步骤 6 |
| 工作区外临时验证目录 | 当前步骤所需的契约、组件和闭环验证，不交付测试源码 | 各步骤执行时临时生成 |

目录是新工程默认约定，存在现有结构时保持项目风格并更新实际路径映射

### 6.2 共享接口

| 接口 | 精确约定 |
|---|---|
| `load_package(path)` | 返回已校验的 PackageDescriptor，读取描述时不执行插件代码 |
| `bind_system(config, registry)` | 返回 BoundSystem 或带字段路径与原因的校验错误 |
| `submit(request)` | 返回 operation_id，只有实际接受请求才进入 ACCEPTED |
| `get_operation(operation_id)` | 返回状态、反馈、结果、错误与独立 stop_state |
| `cancel(operation_id)` | 请求取消并返回当前快照，不直接伪造 CANCELED |
| `take_control(mode, owner)` | 返回控制令牌，包含 control_epoch、owner 和过期时间 |
| `validate_control(token, resources)` | 最终模拟设备网关在产生副作用前校验 |
| `start_system(config_ref)` | 返回 system_run_id，幂等处理重复启动 |
| `start_task(task_ref, config_ref, request_id)` | 校验并冻结快照，返回 task_run_id |
| `cancel_task(task_run_id)` | 停止派发新动作，追踪在途动作取消与停止结果 |

ExecutionRequest 至少包含 capability_id、backend_instance、input、parameters、request_id、task_run_id、node_id 和控制授权

操作状态采用 ACCEPTED、RUNNING、CANCELING、SUCCEEDED、FAILED、CANCELED、UNKNOWN，拒绝请求使用结构化错误，不创建假执行实例

stop_state 单独表示 CONFIRMED、UNCONFIRMED、NOT_APPLICABLE，CANCELED 仅在适用停止已确认后允许出现

资源授权与结果未知分开处理，未确认停止时不能只因资源租约到期就放行下一个物理动作

时间戳声明 clock_domain，同一主机超时使用单调时钟，时间域不兼容时拒绝直接判断数据新鲜度

### 6.3 当前阶段技术选择

新工程默认采用 Python 管理核心、FastAPI 管理 API、SQLite 最小台账、C++ 与 CMake 构建 BehaviorTree.CPP 执行器

Agent 与 C++ 执行器先通过本机 HTTP/JSON 能力桥通信，耗时能力使用 submit、poll、cancel，不让 tick 线程执行阻塞网络请求

Python、C++ 和 GUI 未来均使用同一契约样例验证消息语义，不在两个语言中独立猜测类型或状态映射

具体依赖兼容性在对应实施步骤内验证并记录，不在本计划中虚构已可用的依赖组合

## 7 最低成本验证路径

当前阶段依次使用契约校验、组件测试、C++ 构建和模拟闭环，不安排台架或真机实验

以下命令是计划要求实现并执行的验证入口，不表示当前已有这些命令或文件

- Python 组件使用 `python -m pytest tests/<对应文件> -q`
- C++ 使用 `cmake -S task_engine -B build/task_engine` 与 `cmake --build build/task_engine`
- 行为树测试使用 `ctest --test-dir build/task_engine --output-on-failure`
- 跨语言与任务闭环使用 `python -m pytest tests/test_bt_bridge.py tests/test_tomato_closed_loop.py -q`

测试仅覆盖当前完成条件，故障采用确定性注入和可控时钟，避免为等待超时建立长时间实验

## 8 总执行 Prompt

下面内容必须附加到每一个步骤的 Codex Prompt 前面

```text
你正在实现农业机器人系统集成框架
先读取 docs/architecture.md、docs/plan.md、AGENTS.md 和当前步骤直接相关代码、配置与测试
没有目标仓库时不要猜测远程地址或修改其他项目，先将本步骤作为可审查的新工程实现

本次只完成指定步骤及其验证，不顺带重构，不增加当前完成标准之外的能力
已经存在的等价实现先核对并复用，不为迎合计划目录移动文件或重复建设
保持项目现有命名、组织、接口、错误处理、日志和注释风格
代码阅读、依赖确认与修改点定位是本步骤准备，不另立模糊分析步骤

不主动新建或切换分支，不执行 git commit、git push、合并、发布或部署到用户设备
如执行环境强制隔离，仅使用已有授权的隔离工作区，不自行改动用户当前分支
仅修改本步骤需要的源码、配置、资源及计划进度，测试与验证脚本仅在工作区外临时目录执行，不向仓库交付测试源码
当前步骤未完成前不修改无关 README、CHANGELOG、设计文档或其他计划
直接使用前序步骤明确的接口，必要接口变更记录证据并仅修订受影响部分

新增自然语言说明、Markdown 与汇报不用中文句号，段落末尾不添加句号、逗号、分号、冒号、感叹号或问号
不在新增项目文案、注释或文档中写发布版本号、升级叙事或版本前后对比
上述要求不影响必要的依赖锁定、协议兼容性字段、代码语法、XML 或原有约定

使用能直接证明完成条件的最低成本验证，不增加无关 benchmark、长稳或真机实验
重要代码修改完成前使用 requesting-code-review 若可用
每次标记完成前使用 verification-before-completion 若可用
验证未执行、未通过或证据不新鲜时不能标记 PASS

新问题不阻塞目标则进入 Later Optional，不改当前进度
确实阻塞时记录证据，只调整受影响步骤，保留已完成与仍有效的内容
不因执行计划自动启动其他阶段或外部仓库修改

最终只汇报修改文件、实际变化、真实验证命令、真实结果、未验证项和需要用户执行的操作
步骤完成报告不等于整阶段验收通过
```

## 9 当前阶段实施步骤

### 步骤 1 `[x]` 建立接入契约与能力注册

**目标**

导入描述、校验系统配置并将能力角色绑定到后端实例，形成后续执行与 GUI 共同使用的数据模型

**修改范围**

`contracts/`、`src/agro_runtime/registry.py`、初始 `cli.py`、`pyproject.toml`、`tests/test_registry.py` 与契约样例

**必做**

- 定义 PackageDescriptor、CapabilityDescriptor、SystemConfig、StampedPose、ExecutionRequest 与 OperationSnapshot
- 定义参数类型、单位、范围、默认值、应用策略与必填规则，完成请求和描述的双向校验
- 能力标识、实例标识、角色映射及资源名称采用明确规则，重复标识和不兼容绑定拒绝注册
- 输出字段路径、错误码和人可读原因，未知执行字段拒绝，展示扩展元数据单独容纳
- 实现 `load_package(path)` 与 `bind_system(config, registry)`，描述导入不执行插件
- 增加 `agroctl package validate <路径>` 与 `agroctl system validate <配置>` 的静态命令

**禁止**

不实现插件安装器、GUI、ROS 自动业务推断或所有机器人消息类型全集

**最小验证**

- [x] 有效番茄模拟接入包通过，重复能力、缺少单位和非法范围失败且指出字段
- [x] 缺失角色、未知后端和不兼容输入类型拒绝绑定
- [x] 仅导入描述不会执行适配器，启用状态与描述可见性分别保存
- [x] `python -m pytest tests/test_registry.py -q` 全部通过

**实际完成证据**

- 实现 `src/agro_runtime/models.py` 的六个共享模型、严格字段与语义校验，`errors.py` 统一字段路径、错误码与原因
- 实现 `load_package(path)`、`Registry`、`bind_system(config, registry)`、请求与结果校验及两个静态 CLI 命令
- 注册描述默认未启用，显式允许入口只更新启用状态，导入、绑定、授权与禁用均不导入适配器代码
- 契约与番茄模拟样例位于 `contracts/`，共享 Schema 从 Python 模型导出，使用说明位于 `contracts/README.md`
- 静态参数只支持 string、integer、number、boolean，带时间戳的 stamped_pose 用于输入输出，后续如需位姿参数必须先定义配置生效与时钟语义
- 独立代码审查发现三项阻塞问题，默认值缺省语义丢失、超大整数溢出与无法校验的位姿参数均已用回归测试修复
- 非阻塞项为位姿 choices 的深层描述校验，记录于 Later Optional，执行请求仍校验完整位姿
- Python 3.10.12 隔离环境位于 `/tmp/agro-step1-venv`，未继承系统包，实际依赖为 Pydantic 2.13.5、PyYAML 6.0.3、pytest 8.4.2、setuptools 79.0.1
- `python -m pytest tests/test_registry.py -q` 结果为 48 passed
- `agroctl package validate contracts/examples/tomato_mock.package.yaml` 返回 valid=true、enabled=false
- `agroctl system validate contracts/examples/tomato_mock.system.yaml` 返回 valid=true，picking_arm 绑定 arm_left 的 manipulation.move_to_pose
- 完成步骤 1 不代表 P1 验收通过，适配器执行、控制有效性、行为树与真实设备尚未进入本次验证

**Codex Prompt**

```text
完成步骤 1，按修改范围建立最小接入契约、注册表与静态 CLI
产出 load_package(path)、bind_system(config, registry) 及共享数据模型
先用契约样例证明字段校验与不执行插件，再实现最小校验入口
保留能力角色与后端实例分离，错误包含字段路径与原因
只运行 test_registry.py 和对应 CLI 校验，不启动机器人或建设插件平台
```

### 步骤 2 `[x]` 实现异步能力执行与模拟适配器

**前置条件**

步骤 1 通过，ExecutionRequest 与 OperationSnapshot 已确定

**目标**

可提交、观察和取消模拟能力，区分命令接受、执行完成、停止确认与结果未知

**修改范围**

`src/agro_runtime/execution.py`、`adapters/mock/`、工作区外临时 `test_execution.py`

**必做**

- 实现 submit、get_operation、cancel 和异步适配器入口，预留调用前授权检查接口
- 提供导航、检测、位姿变换、机械臂运动、末端操作与结果验证的最小模拟能力
- 启用适配器必须显式允许，描述文件不能指定任意 shell 作为默认能力入口
- 状态转换遵守共享契约，取消已完成操作保持原结果，重复取消不生成第二个动作
- 为每个操作提供独立执行与取消确认超时，结果未知停止自动重试
- 故障注入支持慢启动、执行失败、反馈过期、结果丢失和取消未确认

**禁止**

不把模拟成功作为真实机械臂、电控或导航已验证，不引入真实设备连接

**最小验证**

- [x] 接受请求后先 RUNNING 再 SUCCEEDED，过程存在可读反馈
- [x] 取消请求只进入 CANCELING，停止确认后才 CANCELED
- [x] 结果丢失进入 UNKNOWN，停止未确认保持 UNCONFIRMED
- [x] 同一 request_id 重复提交不重复执行，不同载荷复用该 ID 被拒绝
- [x] 临时目录中的 `test_execution.py` 全部通过

**实际完成证据**

- 新增 `src/agro_runtime/execution.py`，实现异步 submit、快照查询 get_operation、非阻塞 cancel、显式适配器加载与本地追踪清理
- 新增 `adapters/mock/`，安装模块为 agro_mock，提供导航、单目标检测、位姿平移、机械臂运动、末端夹持释放与结果验证
- 更新 OperationFeedback 的可选时间戳和时间域，以及 OperationSnapshot 的 cancel_requested 与 cancel_accepted，共享 Schema 已从权威模型重新导出
- 执行超时触发取消，取消确认使用独立期限，未确认停止进入 UNKNOWN，迟到的停止确认只更新 stop_state，未知结果保留供核对
- 同一 request_id 的相同载荷只执行一次，载荷冲突返回结构化错误，当前去重保存在内存中，未声称支持重启持久化去重
- 使用注入时钟验证慢启动、执行失败、过期反馈、结果丢失、取消未确认与独立超时，没有长时间等待或真机动作
- 预留 authorize(request, resources)，接纳前与最终模拟副作用前均检查，异步检查返回后再次核对关闭、取消、启用状态、执行期限和数据新鲜度
- 独立代码审查复现六个阻塞问题，取消覆盖已完成结果、异步授权竞态、关闭后接纳、迟到停止确认丢失、延迟动作数据过期与不支持取消声明被忽略，均已通过先失败再通过的回归验证修复
- 步骤 1 验证脚本已移到 `/tmp/agro-step2-tests/test_registry.py`，步骤 2 验证脚本位于 `/tmp/agro-step2-tests/test_execution.py`，仓库不交付测试源码
- 实际命令 `PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 /tmp/agro-step1-venv/bin/python -m pytest /tmp/agro-step2-tests/test_execution.py /tmp/agro-step2-tests/test_registry.py -q -p no:cacheprovider` 结果为 71 passed
- 取消只追踪确认，资源仲裁、控制令牌有效性与持久化台账仍属于步骤 3，完整模拟采摘任务与行为树尚未验收

**Codex Prompt**

```text
完成步骤 2，仅实现异步执行和显式启用的模拟适配器
使用步骤 1 模型，不另建状态或消息体系
产出 submit、get_operation、cancel 与可确定注入故障的模拟能力
用可控时钟验证超时，区分取消接受与实际停止确认
完成 test_execution.py，保留授权检查入口给步骤 3
```

### 步骤 3 `[x]` 加入模式、资源门控与最小操作台账

**前置条件**

步骤 2 通过，执行状态与适配器调用入口可复用

**目标**

模拟任务只能在合法模式与有效控制权下动作，接管、重复请求和重启不能产生陈旧操作

**修改范围**

`src/agro_runtime/control.py`、`records.py`、必要的执行入口接线、模拟设备网关、工作区外临时 `test_control.py`

**必做**

- 实现 STANDBY、MANUAL、AUTO、CALIBRATION、FAULT 的合法转换，急停状态独立输入且只能由设备确认解除
- 启动系统进入 STANDBY，开始任务检查并转 AUTO，非法请求返回原因
- 实现 take_control 与 validate_control，控制令牌具备 owner、control_epoch 与过期时间
- 模拟设备网关在副作用发生前检查令牌，接管增加 control_epoch 并拒绝旧令牌
- 多资源按稳定顺序获取或全量原子尝试，支持超时与可靠释放，未确认停止的资源进入隔离状态
- SQLite 记录 request_id、operation_id、目标 ID、意图与结果，重启时在途动作转为待核对，不自动重发
- 记录去重只防止已知重复请求，不声称单靠台账能够保证物理 exactly-once

**禁止**

不把单机门控称为硬件安全认证，不实现分布式锁，不支持自动恢复未知运动

**最小验证**

- [x] 同一机械臂并发请求只允许一个持有独占资源
- [x] 取消未确认后新的相同资源动作被阻止，不能借租约到期绕过
- [x] 人工接管后延迟到达的旧请求被最终网关拒绝
- [x] 重启读取台账但不重放动作，相同请求标识不会再次产生副作用
- [x] 临时 test_control.py 与前序执行、契约回归验证全部通过

**实际完成证据**

- 新增 `src/agro_runtime/control.py`，实现 STANDBY、MANUAL、AUTO、CALIBRATION、FAULT 的转换、任务开始门控、控制代次、令牌过期与资源隔离
- 新增 `src/agro_runtime/records.py`，SQLite 记录 request_id、operation_id、目标 ID、意图、资源、反馈、结果和待核对标记，授权代次与急停锁存状态也持久化
- 执行器要求调用方显式提供台账，不默认创建易丢失的内存台账，步骤 4 将配置实际状态目录，显式 :memory: 仅用于隔离验证
- 接纳前持久化操作意图，执行中更新快照，重启把在途动作或未完成意图转为 UNKNOWN 并恢复资源隔离，同一已知请求不会再次调用适配器
- 多资源全量原子尝试，默认冲突立即拒绝，可用 resource_timeout_s 配置有界等待，不会持有部分资源等待其他资源
- 最终模拟设备网关在副作用前独立检查控制与资源，移除执行入口授权钩子后旧令牌仍被网关拒绝
- 人工接管和重启推进 SQLite 中的 control_epoch，令牌到期不会释放未确认停止的资源，迟到停止确认更新台账后才解除相应隔离
- 急停是独立设备状态，普通模式切换不能解除，设备确认解除后仍需故障复位，重复正常状态报告不撤销有效授权
- 独立代码审查发现急停存储失败未锁存与存储失败阻止关闭清理两项阻塞问题，均已先复现失败再完成回归修复，存储失败时继续阻止动作并清理本地追踪任务，接管与故障模式切换也先撤销本地旧授权再写入代次
- 验证脚本位于 `/tmp/agro-step3-tests/test_control.py` 与前序临时目录，仓库不交付测试源码
- 实际命令 `PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 /tmp/agro-step1-venv/bin/python -m pytest /tmp/agro-step3-tests/test_control.py /tmp/agro-step2-tests/test_execution.py /tmp/agro-step2-tests/test_registry.py -q -p no:cacheprovider` 结果为 92 passed
- 未实现多进程或分布式资源仲裁、物理 exactly-once、真实设备安全认证与自动恢复未知运动，运行管理、管理 API 和完整任务会话仍属于后续步骤

**Codex Prompt**

```text
完成步骤 3，复用步骤 2 执行入口加入模式、控制令牌、资源隔离和 SQLite 操作台账
把最终校验放到模拟设备网关，不能只检查 Agent 请求入口
实现 take_control 与 validate_control，接管撤销旧代次授权
台账持久化意图与结果，重启只核对，不重发
验证资源冲突、停止未确认、旧请求和重启去重，不接真机或建设分布式仲裁
```

### 步骤 4 `[x]` 打通运行管理、Agent 与统一 CLI

**前置条件**

步骤 1 至 3 通过

**目标**

由同一个运行核心完成系统启动停止、状态查询与操作管理，CLI 不拼接任意 shell 命令

**修改范围**

`src/agro_runtime/runtime.py`、`api.py`、`cli.py`、配置快照存储、`tests/test_runtime_api.py`

**必做**

- 定义运行目标、模块依赖、进程管理者、启动与停止超时，拒绝依赖环
- 开发模拟模块使用本地进程组管理，生产 systemd 路径以可替换适配器实现并用伪造服务管理器测试
- Agent 不与 systemd 或 launch 同时管理相同子进程，重复启动合并到同一个 system_run_id
- 就绪检查分别汇总进程、接口、数据与授权状态，检查按能力和任务阶段触发
- API 默认监听回环地址，明确本地会话身份校验，保留将来 SSH 隧道路径
- 建立 package、system、operation、control 的管理 API，HTTP 返回接受不等于动作成功
- 配置以不可变快照应用，原生后端配置引用与框架配置分别校验
- CLI 提供 system start/status/stop、operation status/cancel、control take，显示可解释阻塞原因
- 停止系统先阻止新任务再取消在途操作，停止未确认时保留控制网关和必要诊断，不立即杀掉全部进程
- GUI 尚未存在时通过 CLI/API 测试验证客户端断开不会触发未经声明的任务取消

**禁止**

不实现多主机管理、SSH 凭据界面、设备部署或完整参数热更新

**最小验证**

- [x] 慢启动、模块缺失、依赖环分别产生正确状态与原因
- [x] 重复启动不创建第二份进程，模拟崩溃不自动重放操作
- [x] 当前不需要定位的模块能进入就绪，不误用整机统一门槛
- [x] API 结果、CLI 输出和核心状态一致，未授权本地会话拒绝控制请求
- [x] `python -m pytest tests/test_runtime_api.py -q` 全部通过

**实际完成证据**

- 实现 `runtime.py` 的单机生命周期、依赖排序、唯一管理者校验、启动停止超时、崩溃监测与按能力及阶段的四类就绪检查，启动后进入 STANDBY，重复启动复用同一 system_run_id
- 本地及 launch 根进程使用独立进程组，持久化 PID、启动时间、主机启动身份和配置身份，组根继承管理锁，Agent 重启识别遗留组或拒绝重复启动，状态目录用排他锁限制单 Agent
- systemd 路径通过可替换管理器发出 unit 请求，默认适配器使用用户级 systemctl，所有生命周期验证使用 FakeServiceManager，不修改当前主机服务
- 实现 `api.py` 的 package、system、operation、control 管理入口，所有请求校验本地 Bearer 会话，Agent 默认监听回环地址，CLI 只调用同一 API，HTTP 接受与动作完成分别查询
- 配置保存为内容摘要标识的只读快照，返回值为独立副本，原生配置独立校验，本地 argv 通过 `{native_config}` 读取冻结文件，systemd 后端缺少冻结配置应用器时拒绝启动
- system stop 先关闭派发并撤销授权，再取消在途操作，UNKNOWN/UNCONFIRMED 与模块停止超时保留 STOP_UNCONFIRMED、网关及诊断，正常退出信号也等待停止确认
- 重启恢复 RECOVERING 与原运行 ID，历史未确认操作不会被初始 STOPPED 状态覆盖，旧操作不重放，停止核对后才能重启模块
- 新增模拟启动配置 `adapters/mock/system.yaml` 与模块入口 `worker.py`，在 `adapters/mock/README.md` 记录 CLI、会话、就绪、配置冻结与恢复方法，不进入任务或行为树步骤
- 步骤 4 验证脚本为 `/tmp/agro-step4-tests/test_runtime_api.py`，20 项覆盖慢启动、超时、缺失模块、依赖环、启动幂等、伪造 systemd、能力及阶段门槛、未授权会话、非法认证编码、CLI 阻塞原因、客户端断开、停止未确认、崩溃去重、原生配置冻结和恢复状态
- 新上下文只读代码审查提出三项重要问题，重启后错误报告停止完成、原生配置未实际冻结、遗留进程重复启动均已修复，并用临时回归及真实崩溃演示验证，无遗留重要问题
- `PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 /tmp/agro-step1-venv/bin/python -m pytest /tmp/agro-step4-tests/test_runtime_api.py /tmp/agro-step3-tests/test_control.py /tmp/agro-step2-tests/test_execution.py /tmp/agro-step2-tests/test_registry.py -q -p no:cacheprovider` 返回 112 passed
- 原有 package validate 与 system validate 样例仍返回 valid=true，新模拟系统静态校验通过，依赖环在静态 CLI 校验阶段即拒绝
- 在 `/tmp/agro-step4-package` 构建 wheel，安装到 `/tmp/agro-step4-installed` 后验证 runtime、API、CLI、模拟 worker 与 package/system 配置随包交付，`pip check` 返回 No broken requirements found
- `/tmp/agro-step4-tests/demo.py` 通过真实回环 HTTP 完成 system start、AUTO 授权、operation submit/status、system stop，实际运行 ID 为 `system_f69f96191b10497b9d57bd7b049f2b45`，操作 ID 为 `operation_077a41a0880c4de98781ccf6312848b0`，操作结果 SUCCEEDED/CONFIRMED，系统回到 STOPPED/STANDBY，Agent 退出码为 0
- `/tmp/agro-step4-tests/crash_demo.py` 终止临时 Agent 后识别遗留模拟进程，恢复运行 ID `system_a494691594c841dab6e7868d2ea51181`，保持 RECOVERING 并完成停止，不创建第二份模块
- `git diff --check` 通过，测试、构建与运行状态文件均在工作区外，不交付测试源码，不创建提交或自动进入步骤 5

**Codex Prompt**

```text
完成步骤 4，连接现有注册、执行、门控与台账，不另建 CLI 专用逻辑
实现单机 runtime、FastAPI 管理入口、配置快照和统一 CLI
明确唯一进程管理者，重复启动幂等，慢启动与未就绪原因可观察
systemd 操作用测试替身验证，不修改当前主机服务
停止未确认时保持必要网关与诊断，执行 test_runtime_api.py
```

### 步骤 5 `[ ]` 接入实际 BehaviorTree.CPP 执行器

**前置条件**

步骤 4 API 可用，共享契约与执行状态已经验证

**目标**

真实 C++ 行为树加载 XML，异步调用统一能力接口，并正确处理端口、反馈与取消

**修改范围**

`task_engine/CMakeLists.txt`、`task_engine/src/`、`task_engine/tests/`、共享 JSON 样例、`tests/test_bt_bridge.py`

**必做**

- 注册调用框架能力的异步动作节点与条件节点，节点携带 node_id 并绑定 role 或 backend_instance
- XML 使用 BehaviorTree.CPP 标准控制节点，节点模型与端口从注册表派生，能力参数经共享契约校验
- C++ 客户端使用 submit、poll、cancel，网络处理放在有界工作线程或事件循环，tick 线程只读取完成状态
- RUNNING 映射持续执行，SUCCEEDED 映射 SUCCESS，失败与 UNKNOWN 映射失败并保留业务原因
- halt 发出取消并移交停止追踪，任务层不能因节点变 IDLE 就当作设备停止
- 支持有类型的 StampedPose、目标列表和单果结果转换，数值同类型不允许绕过单位或坐标系校验
- 任务停止与单节点 halt 都停止后续派发，取消等待受独立超时管理
- 服务断线不阻塞 tick，已产生副作用但结果未知时不自动重新提交
- 分别保存树状态与操作状态，UNKNOWN 等信息不压缩成无原因的 FAILURE

**禁止**

不使用 Python 流程模拟器替代 BehaviorTree.CPP，不编写画布或修改 MCU 控制周期

**最小验证**

- [ ] Sequence、Fallback 与子树在真实引擎中执行，端口映射可追踪
- [ ] 慢能力持续 RUNNING，取消和服务断线时 tick 不被网络阻塞
- [ ] XML 引用未知节点、错误端口类型或无后端绑定时执行前失败
- [ ] `cmake -S task_engine -B build/task_engine` 成功
- [ ] `cmake --build build/task_engine` 成功
- [ ] `ctest --test-dir build/task_engine --output-on-failure` 全部通过
- [ ] `python -m pytest tests/test_bt_bridge.py -q` 全部通过

**Codex Prompt**

```text
完成步骤 5，构建真实 BehaviorTree.CPP 执行器和本机能力桥客户端
使用步骤 4 API 与步骤 1 数据样例，避免复制一套不同的契约
让 tick 不等待网络，halt 请求取消但停止确认继续由操作追踪完成
固定节点模型、role 绑定与端口转换，保留结构化失败原因
运行 CMake、CTest 与 test_bt_bridge.py，不开发 GUI 或真实 ROS 适配器
```

### 步骤 6 `[ ]` 完成番茄模拟任务与阶段验收

**前置条件**

步骤 1 至 5 通过

**目标**

集成已验证模块，由 CLI 开始、观察和取消番茄采摘任务，并保存最小可追溯运行记录

**修改范围**

`examples/tomato_picker/`、Agent 任务会话接线、CLI task 命令、快照与事件记录、`tests/test_tomato_closed_loop.py`

**必做**

- 提供模拟系统配置、能力接入包、标定样例、任务 XML 和独立节点布局占位文件
- 模板覆盖导航到作业点、检测、选择目标、坐标变换、可达性检查、接近、末端操作、撤回、验证、放置和台账更新
- 空候选列表、单果失败、区域完成使用明确业务结果，控制节点据此选择分支
- 当前作业点采用有限候选集与有限恢复次数，重试资格由错误分类决定
- start_task 冻结任务树、系统绑定、参数与资产校验值，保存软件来源和事件
- 软件来源可记录 Git 提交或源码树校验值，不向文案添加发布版本号
- start_task 使用 request_id 去重，cancel_task 先停止派发再追踪在途停止
- 增加 CLI task start/status/cancel，状态显示当前节点、operation_id、阻塞原因与未知结果
- 切断观察客户端不会自动结束机器人端任务，重新连接能查询同一 task_run_id
- 明确正常放置完成才记录单果成功，末端命令接受不能替代采摘验证

**禁止**

不把模拟闭环标为真机验收，不实施后续 GUI 或真实后端阶段

**最小验证**

- [ ] 正常场景完成导航、采摘、放置和台账，运行记录完整可读取
- [ ] 空目标正常结束，不进入无限重试
- [ ] 坐标系不匹配、过期观测和错误资产在产生运动前被拒绝
- [ ] 用户取消、停止未确认、人工接管分别产生预期终态或待处理状态
- [ ] 结果丢失不重复采摘，断开观察和重启 Agent 不重放操作
- [ ] 修改草稿后当前 task_run_id 的快照校验值不变
- [ ] `python -m pytest tests/test_tomato_closed_loop.py -q` 全部通过
- [ ] `python -m pytest tests/test_registry.py tests/test_execution.py tests/test_control.py tests/test_runtime_api.py tests/test_bt_bridge.py tests/test_tomato_closed_loop.py -q` 全部通过
- [ ] 实际执行 `agroctl system start examples/tomato_picker/system.yaml`，随后通过 `agroctl task start examples/tomato_picker/tasks/harvest.xml` 和 `agroctl task status <实际 task_run_id>` 观察闭环

**Codex Prompt**

```text
完成步骤 6，只集成已经实现的运行核心与 C++ 执行器
实现 examples/tomato_picker 模拟配置、任务、最小资产和台账闭环
提供 start_task、cancel_task 与 CLI task start/status/cancel
运行配置按快照冻结，空目标与未知结果使用业务语义，重启不得重放运动
用同一模拟场景覆盖正常、取消、接管、陈旧数据与重复请求，不增加真机实验
完成组件回归与一次真实 CLI 演示，记录实际任务 ID 和输出，再按完成标准验收 P1
```

## 10 最终验收与交接

- [ ] 六个步骤均具备真实完成证据，P1 完成标准逐项通过
- [ ] Python、C++ 与 HTTP/JSON 使用相同状态、字段与错误语义
- [ ] 已明确请求接受、动作完成、取消接受、停止确认与采摘结果的区别
- [ ] 接入包仅导入不执行代码，已启用适配器身份可追溯
- [ ] 没有未授权外部仓库修改、用户设备部署或真机动作
- [ ] 使用契约、组件、构建和模拟证据，没有增加无关硬件实验
- [ ] 后续 P2 可复用管理 API、节点注册数据、配置快照和运行事件，不需要重写运行核心

当前最需要关注的五类失效由对应步骤验证

| 失效 | 所属步骤 | 预期结果 |
|---|---|---|
| 取消接受但设备尚未停止 | 2、3、6 | 保留停止未确认并阻塞冲突动作 |
| 旧控制请求在人工接管后到达 | 3、6 | 最终网关拒绝旧代次令牌 |
| 副作用已发生但结果丢失或进程重启 | 2、3、6 | 标记 UNKNOWN 并核对，禁止盲目重发 |
| GUI 未来编辑的草稿与运行配置混淆 | 4、6 | 不可变任务快照与实际生效状态可查 |
| 网络阻塞导致行为树不能响应 | 5、6 | tick 不阻塞，取消由异步操作追踪 |

## 11 Later Optional

以下内容不属于当前阶段或既定 P1 至 P5 验收条件，不影响当前进度

- 云端机器人集群管理与跨组织账号体系
- 接入包市场、在线安装与自动升级
- 复杂任务断点恢复、跨任务调度和自动优化
- 采摘效率 benchmark、长期田间可靠性研究与论文实验
- 自动生成任意后端适配器和自动推断未知业务语义
- 位姿 choices 描述的深层静态校验，当前请求入口仍逐字段校验完整位姿

## 12 当前立即执行

步骤 1 至步骤 4 已完成，实际接口、样例与验证证据见第 9 节

下一步为步骤 5，后续收到执行请求时将总执行 Prompt 与步骤 5 Codex Prompt 一起交给当前仓库中的 Agent，验证脚本遵守工作区外临时执行约束，本次不自动启动后续步骤

## 13 进度统计

| 步骤 | 任务 | 状态 |
|---|---|---|
| 1 | 接入契约与能力注册 | [x] |
| 2 | 异步能力执行与模拟适配器 | [x] |
| 3 | 模式、资源门控与操作台账 | [x] |
| 4 | 运行管理、Agent 与 CLI | [x] |
| 5 | 实际 BehaviorTree.CPP 执行器 | [ ] |
| 6 | 番茄模拟任务与阶段验收 | [ ] |
| 最终验收 | P1 完成标准核对 | [ ] |

当前已完成 4 / 6，步骤 1 至步骤 4 通过，P1 最终验收仍未完成

后续阶段只有 P1 验收通过后才依据真实接口细化，每阶段继续遵守 mini-step-plan，不提前把路线图扩成几十个未验证任务
