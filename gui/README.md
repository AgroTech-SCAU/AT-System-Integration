# 本机桌面 GUI

GUI 使用 Electron 独立桌面窗口，沿用 SerialArm-Core 的启动形式，内部界面与 Agent 管理接口同源，提供系统搭建、模板任务、运行调试和记录报告四个工作区

界面以 [SerialArm-Core](https://github.com/Kaede-Rei/SerialArm-Core) 的 launcher 为模板，沿用深浅主题、琥珀强调色、紧凑标题栏、分组侧栏和卡片工作台，外观、语言与紧凑布局位于独立设置页

保留 React 与同源 Agent API，加入无边框窗口、拖动标题栏和最小化、最大化/还原、关闭按钮，机械臂执行与终端桥按当前项目计划实现，来源与授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

P2 已提供描述导入、系统草稿、停止态应用、模板参数、模拟标定资产、任务操作与脱敏报告，行为树画布按后续 P3 实施

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

安装完成后无需激活环境或填写配置路径，直接执行 `./launch.sh` 即可打开独立应用窗口，首次使用番茄模拟配置，后续沿用 GUI 已应用配置，不自动启动模块或采摘任务

已有 Agent 通过项目来源、配置摘要和状态目录核对后复用，目标端口空闲才启动 Agent，打开 GUI 不重新安装或构建

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

`--no-window` 只核对或启动 Agent 并输出连接信息，用于命令行诊断，不打开窗口，旧参数 `--no-browser` 作为兼容别名保留

重复启动复用同一 Agent 并聚焦已有桌面窗口，桌面偏好保存在指定状态目录的 `desktop/`，桌面诊断写入 `desktop.log`

已有旧版安装时重新执行 `./install.sh`，缺少 Electron 时启动入口会明确提示，默认不回退到浏览器

Linux 需要可用的图形桌面及 Electron 所需系统库，缺少图形会话或动态库时查看 `desktop.log`，安装脚本不修改系统权限或禁用 Chromium 沙箱

`AGRO_PYTHON` 可覆盖启动解释器，`AGRO_GUI_DIST` 可指定自定义 GUI 构建目录，`AGRO_BUILD_JOBS` 控制安装时的 C++ 构建并行数

手动开发构建仍可使用

```bash
npm --prefix gui run typecheck
npm --prefix gui run build
```

手动构建默认输出至 `/tmp/agro-gui-dist`，使用该目录启动时传入 `--ui-dir /tmp/agro-gui-dist --desktop-dir .install/desktop`

## 会话与观察

启动器核对本机管理后台身份后，桌面主进程读取指定的本机会话文件并再次核对，打开窗口直接进入系统搭建，通常无需手动连接

自动连接失败时才显示诊断连接入口，可选择 `<状态目录>/session.token` 或输入内容，界面不能任意读取后台文件系统

凭据仅驻留页面内存，不写入 URL、桌面持久存储、日志或报告，401 清理会话并回到诊断连接页，重新打开窗口会自动核对连接

主题、语言与紧凑布局独立保存于桌面设置，会话凭据不使用该存储，草稿、方案与管理结果保存在后台，页面只保存无凭据的请求标识用于核对

失去连接后移除旧状态，显示未观测和最后成功观测时间，只重试状态查询，不重发控制请求

关闭应用窗口、断开观察或关闭等待弹窗都不会取消 Agent 持有的任务，等待弹窗提供适用的取消和停止入口，关闭弹窗或离开页面只停止本次观察

## 系统集成与任务流程

1. 在「系统搭建」导入 package.yaml 内容，查看服务端能力与参数描述，导入不执行适配器代码
2. 从当前系统创建草稿，添加后端实例、绑定兼容角色、编辑参数，保存并校验，再查看字段差异
3. 确保系统已停止、任务与设备停止已确认，再应用已保存草稿，应用不会启动模块或任务
4. 在「模板任务」选择内置番茄模板与模拟标定资产，设置 approach_dz，保存不可变方案并预检
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
