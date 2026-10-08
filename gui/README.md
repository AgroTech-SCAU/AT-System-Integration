# 本机桌面 GUI

GUI 使用 Electron 独立桌面窗口，沿用 SerialArm-Core 的启动形式，内部界面与 Agent 管理接口同源，提供总览、系统搭建、任务编排、运行调试和记录报告五个工作区

界面以 [SerialArm-Core](https://github.com/Kaede-Rei/SerialArm-Core) 的 launcher 为模板，沿用深浅主题、琥珀强调色、紧凑标题栏、分组侧栏和卡片工作台，外观、语言与紧凑布局位于独立设置页

保留 React 与同源 Agent API，加入无边框窗口、拖动标题栏和最小化、最大化/还原、关闭按钮，机械臂执行与终端桥按当前项目计划实现，来源与授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

保留描述导入、系统草稿、停止态应用、标定资产、任务操作与脱敏报告，并将模板参数与行为树画布统一放入「任务编排」

## 安装与打开

首次使用，在仓库根目录执行

```bash
./install.sh
./launch.sh
```

安装脚本创建独立 Python 环境、安装当前管理核心与前端依赖，检查前端类型并构建 GUI、安装 Electron 运行时和实际行为树执行器，不启动 Agent、系统模块或任务

默认安装位置为仓库内的 `.install/`，Python 环境、GUI 产物、桌面运行时、C++ 构建和运行状态分别保存在其中的 `venv/`、`gui/`、`desktop/`、`task-engine/` 和 `state/`，安装信息位于 `.install/installation.json`

`.install/` 整体忽略 Git 提交，前端依赖位于忽略提交的 `gui/node_modules`

需要 Python 3.10 或更高、Node.js 22.12 或更高受支持版本、npm、CMake、C++17 编译器、pkg-config 与 libcurl 开发包，脚本会检查并说明缺失工具，不自动执行 sudo 或安装系统包

首次构建会下载固定 BehaviorTree.CPP 依赖，已有源码时可执行 `./install.sh --bt-source /path/to/BehaviorTree.CPP`，执行器说明见 [task_engine/README.md](../task_engine/README.md)

安装完成后无需激活环境或填写配置路径，直接执行 `./launch.sh` 即可打开独立应用窗口，使用中立的本地默认配置，后续沿用 GUI 已应用配置；并不默认创建番茄机器人，不自动启动模块或采摘任务

`./launch.sh` 是前台启动器，不再静默创建常驻后台 Agent；每次使用会自己启动并管理 Agent；如端口被相同项目的旧版遗留后台 Agent 占用，会在严格验证本机 UID、进程参数、项目目录、状态目录、配置路径、端口，以及旧版独立会话和 `agent.log` 日志重定向特征后发出安全停止信号，确认释放后再启动；若无法识别占用者，会提示查看端口，而不是结束未知进程；打开 GUI 不重新安装或构建

在界面创建和校验系统草稿，停止态查看差异并应用，实际生效配置保存在同一状态目录的受控工作区

## 可选路径与参数

自定义安装目录时，安装与启动使用相同环境变量

```bash
AGRO_INSTALL_DIR=/tmp/my-agro ./install.sh
AGRO_INSTALL_DIR=/tmp/my-agro ./launch.sh
```

高级用法仍支持覆盖默认路径，平时无需这些参数

```bash
./launch.sh --config adapters/mock/system.yaml --state-dir /tmp/another-agent
./launch.sh --endpoint http://127.0.0.1:8765 --no-window
```

`--no-window` 只在当前终端启动并持续运行 Agent，不打开窗口，按 `Ctrl+C` 退出；旧参数 `--no-browser` 作为兼容别名保留

同一个状态目录不允许同时启动两个前台管理器，第二次执行 `./launch.sh` 会提示先关闭原窗口或在原终端按 `Ctrl+C`；桌面偏好仍保存在状态目录的 `desktop/`，前台运行日志直接打印到启动终端

已有旧版安装时重新执行 `./install.sh`，缺少 Electron 时启动入口会明确提示，默认不回退到浏览器

Linux 需要可用的图形桌面及 Electron 所需系统库，缺少图形会话或动态库时查看启动终端的 Electron 日志，安装脚本不修改系统权限或禁用 Chromium 沙箱

`AGRO_PYTHON` 可覆盖启动解释器，`AGRO_GUI_DIST` 可指定自定义 GUI 构建目录，`AGRO_BUILD_JOBS` 控制安装时的 C++ 构建并行数

手动开发构建仍可使用

```bash
npm --prefix gui run typecheck
npm --prefix gui run build
```

手动构建默认输出至 `/tmp/agro-gui-dist`，使用该目录启动时传入 `--ui-dir /tmp/agro-gui-dist --desktop-dir .install/desktop`

## 会话与观察

启动器核对本机管理后台身份后，桌面主进程读取指定的本机会话文件并再次核对，打开窗口直接进入总览，通常无需手动连接

自动连接失败时在总览显示「重新连接」；首页没有任何会话令牌输入框；仅在浏览器开发调试环境中，可以在「设置 → 浏览器会话（高级）」读取 `<状态目录>/session.token` 或手工输入凭据；桌面界面不开放任意后台文件读取

凭据仅驻留页面内存，不写入 URL、桌面持久存储、日志或报告，401 清理会话并回到总览，重新打开窗口会自动核对连接

主题、语言与紧凑布局独立保存于桌面设置，会话凭据不使用该存储，草稿、方案与管理结果保存在后台，页面只保存无凭据的请求标识用于核对

失去连接后移除旧状态，显示未观测和最后成功观测时间，只重试状态查询，不重发控制请求

关闭等待弹窗或切换页面只停止本次观察，不会取消 Agent 持有的任务；**关闭整个 Electron 主窗口**则会触发前台启动器请求安全停止系统和 Agent（相当于终端 `Ctrl+C`）；对真实设备应先在运行调试页面主动停止任务、确认安全状态，再退出 GUI；系统停止未确认时仍保留网关，不做强杀

## 开发者工作台入口

启动后默认进入「总览」，提供「新建系统 / 导入系统 / 选择已有系统」三个明确入口；选择机器人之后可查看系统组成与运行状态

- 「系统搭建」优先展示视觉、导航、机械臂、电控四类功能卡片，可展开查看该类能力绑定的具体后端；番茄示例使用四个独立模拟后端，仅在从示例创建后出现在该机器人系统中，然后保存、校验、停止态应用
- 「任务编排」在番茄示例系统中集成采摘任务模板与行为树编辑，点击「从番茄模板创建」可新建树草稿，画布支持搜索节点、中文名称和分类；拖动修改画布位置，兄弟节点执行顺序仍用上移／下移设置
- 「运行调试」负责启动模块、预检、任务派发、取消、停止，编辑任务不会替换已运行任务
- 「记录与报告」查询运行历史，原始配置 JSON、节点 ID、XML、完整角色映射放在高级区域

新示例 `examples/tomato_picker/system_four_backends.yaml` 包含独立的 `vision`、`navigation`、`arm`、`control` 模拟实例；四个实例由同一 Agent 管理，各自有唯一进程目标，在本次运行中共享 MockWorld 状态，不是真实 ROS/Gazebo 物理仿真；启动方式：

```bash
agroctl agent serve --config examples/tomato_picker/system_four_backends.yaml \
  --state-dir /tmp/agro-tomato-four --task-engine /tmp/agro-task-engine/agro-bt
```

注意：未构建 BehaviorTree.CPP 执行器时，模块仍可正常启动，但行为树预检及完整采摘闭环不可用；番茄采摘策略继续限制不安全的动作语义重排，这一版以可理解的工作区与独立模拟接入为目标，不解除安全门控，也不声称支持任意真机树运行

## 系统工程导入与导出

在「总览 → 选择已有系统」点击「导出」，通过桌面文件保存对话框创建 `.agrobot.json` 工程文件；其他设备在「总览 → 导入系统」选择该文件后，会创建新的机器人系统，不覆盖已有系统、不自动选择、不启动任何设备；再次点击「选择」后，必须在停止态完成配置应用；

工程文件包含：系统名称和配置、所需接入包的**描述**、已保存的行为树草稿、已发布定义对应的可编辑草稿、模板任务参数，以及当前受支持的模拟标定资产；工程文件**不包含**：运行凭据、任务运行记录、执行授权、本机绝对路径、ROS/设备驱动可执行依赖或未经验证的真实标定；它不是设备软件的完整部署镜像

导入时校验描述格式、依赖冲突、工程大小、标定资产摘要；导入后的任务定义必须重新校验与发布，不能因为旧机器上执行过就自动获得运行权限；目前仅支持已接入的模拟标定证据，真实机器人应重新核验驱动与标定后才尝试运行

可执行 `python tests/smoke_project_transfer.py` 复测全新状态目录间的导入导出、任务迁移和错误拒绝

## 系统集成与任务流程

1. 在「系统搭建」导入 package.yaml 内容，查看服务端能力与参数描述，导入不执行适配器代码
2. 从当前系统创建草稿，添加后端实例、绑定兼容角色、编辑参数，保存并校验，再查看字段差异
3. 确保系统已停止、任务与设备停止已确认，再应用已保存草稿，应用不会启动模块或任务
4. 在「任务编排」的「采摘模板与参数」中选择内置番茄模板与模拟标定资产，设置 approach_dz，保存不可变方案并预检
5. 在「运行调试」启动系统、查看各项就绪状态、开始任务，观察节点、操作、目标和独立停止状态
6. 在「记录与报告」读取原任务与有限日志，复制或通过本机保存对话框导出脱敏 JSON

运行中、UNKNOWN、停止未确认或遗留进程阻止配置应用，无法证明设备与模拟场景连续的变更也被拒绝，已采摘目标台账持续保留

草稿包含 revision 与基准快照，并发保存冲突需要重新加载，结构错误可在完整草稿 JSON 编辑区修复，旧任务始终查询启动时冻结的配置与资产

当前只接受内置模拟标定的已知验证证据及受支持内容，不提供真实手眼标定或任意六维变换，上传 verified=true 不能替代证据，模块日志尚未完整捕获会明确显示不可用

管理操作返回 management_job_id，需要查询真实结束结果，任务请求在响应丢失时沿用原 request_id 核对，不自动重新派发，明确失败的停止请求可以重新发起

命令行与 GUI 使用同一后台与台账，例如默认工作区

```bash
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token config status
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token catalog list
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token template list
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token plan preflight PLAN_ID
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token management status JOB_ID
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token report TASK_ID
```

## 本地开发

```bash
npm --prefix gui run dev
```

开发服务器只监听 `127.0.0.1`，访问其 `/ui/` 页面，管理查询代理至 `http://127.0.0.1:8765`，仍需 Agent 的会话凭据

## 行为树任务设计

在「任务编排」切换到「行为树编辑」，选择「新建查询树」或「从番茄模板创建」，也可导入支持范围内的 XML，内置模板始终保留

左侧节点库来自实际 C++ 注册信息，中间画布显示控制结构与子节点执行序号，右侧编辑角色、常量、单位和 Blackboard 变量，选中节点后显示相关数据绑定

拖动只调整布局，执行顺序通过上移、下移或 Alt 加方向键调整，控制父节点选择用于重挂，复制片段生成新标识并重写片段内部输出引用，撤销和重做同时恢复结构与绑定

选择完整片段后预览子树端口，核对跨边界输入输出，再确认提取，子树定义可独立编辑，调用节点使用显式端口映射，重复调用具有独立实例路径

保存后点击「校验树」，通过后「发布定义」，发布不会启动系统，在「运行调试」启动系统后可「开始发布任务」，已经发布的定义可以重新选择，未发布的修改不会进入旧定义

「导出 XML」通过桌面保存对话框保存实际编译结果，布局、显示标签和折叠状态独立保存，不支持的 XML 保留原内容并只读，包含脚本、全局引用、混合自动重映射或未支持的子树默认值时禁止覆盖和发布

任务输入和子树端口可在声明 JSON 面板编辑，任务输入沿用标量 ParameterDescriptor，子树端口使用共享 TypeDescriptor 契约，数值声明单位，位姿端口声明坐标系、时间域和有效期，默认参数保持缺省语义，输出只能绑定变量

「查看运行树」读取原 task_run_id 的冻结定义，子树调用实例选择器区分重复调用，点击节点查看实际操作、输入、反馈、错误和状态事件，halt 后区分当前 IDLE 与上次实际状态，草稿编辑不会改变运行快照

断线时保留任务 ID 和陈旧提示，恢复后继续查询原任务，节点 halt 或树 IDLE 不代表设备已经停止，UNKNOWN 和停止未确认持续保留在运行视图与报告中

当前新建任务使用 simulation_inspection 策略，只开放已知模拟只读能力，番茄任务保留原有有限目标、标定、动作顺序、采摘放置验证与台账策略，支持布局、绑定表单和保留原执行语义的子树复用，不开放任意物理动作重排、自动恢复或真机执行

GUI 与 CLI 使用相同校验、发布与启动服务

```bash
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token tree models
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token tree new
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token tree import /tmp/inspection.xml
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token tree validate DRAFT_ID
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token tree publish DRAFT_ID --revision REVISION --base-snapshot SNAPSHOT_ID
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token tree definitions
.install/venv/bin/agroctl --endpoint http://127.0.0.1:8765 --session-file .install/state/session.token tree start DEFINITION_ID --request-id REQUEST_ID
```

保存命令 `tree save DRAFT_ID /tmp/save.json` 接受 revision、layout_revision、document、layout 和 parameters，提取命令 `tree extract /tmp/extract.json` 先返回端口提案，携带确认后的 ports 再提交才提取
