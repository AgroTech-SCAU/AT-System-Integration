# 本机桌面 GUI

GUI 使用 Electron 独立桌面窗口，沿用 SerialArm-Core 的启动形式，内部界面与 Agent 管理接口同源，当前提供系统搭建、模板任务和运行调试三个工作区

界面以 [SerialArm-Core](https://github.com/Kaede-Rei/SerialArm-Core) 的 launcher 为模板，沿用深浅主题、琥珀强调色、紧凑标题栏、分组侧栏和卡片工作台，外观、语言与紧凑布局位于独立设置页

保留 React 与同源 Agent API，加入无边框窗口、拖动标题栏和最小化、最大化/还原、关闭按钮，机械臂执行与终端桥按当前项目计划实现，来源与授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

本步读取实际系统、接入包、控制状态和任务列表，描述导入、配置编辑、任务操作与行为树画布在后续步骤开放

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

安装完成后无需激活环境或填写配置路径，直接执行 `./launch.sh` 即可打开独立应用窗口，默认使用番茄模拟配置，不自动启动模块或采摘任务

已有 Agent 通过项目来源、配置摘要和状态目录核对后复用，目标端口空闲才启动 Agent，打开 GUI 不重新安装或构建

页面中的系统配置编辑按后续 P2-2 与 P2-3 实施，当前打开的是可观察的默认模拟工作区

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

打开应用后选择 `<状态目录>/session.token` 文件或输入其内容，界面只能读取主动选择的文件，不能通过路径直接访问 Agent 文件系统

凭据仅驻留页面内存，不写入 URL、桌面持久存储、日志或报告，401 清理会话并回到连接页，刷新后重新连接

主题、语言与紧凑布局独立保存于桌面设置，系统配置和会话凭据不使用该存储

失去连接后移除旧状态，显示未观测和最后成功观测时间，只重试状态查询，不重发控制请求

关闭应用窗口、断开观察或关闭等待弹窗都不会取消 Agent 持有的任务，当前共享等待组件为后续操作预留取消和停止区域

## 本地开发

```bash
npm --prefix gui run dev
```

开发服务器只监听 `127.0.0.1`，访问其 `/ui/` 页面，管理查询代理至 `http://127.0.0.1:8765`，仍需 Agent 的会话凭据
