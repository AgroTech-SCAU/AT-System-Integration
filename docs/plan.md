# AT-System-Integration P2 实施计划

## 1 本次唯一目标

让集成人员通过 GUI 完成接入包导入、后端绑定、配置与资产管理，并让操作人员通过同一界面启动、观察和取消番茄采摘模拟任务，全程复用 P1 管理核心

依据上传的 `AT-System-Integration.zip` 中 `docs/architecture.md`、`docs/plan.md` 与实际源码，按 KR-Skills/mini-step-plan 的 Full 模板组织六个实施步骤

本文件作为当前 `docs/plan.md`，原 P1 计划已从 Git 提交 `5632ea9` 原样归档至 `docs/archive/plan-p1.md`，只归档一次并保留所有完成记录

本文件作为当前 P2 执行计划，只有完成验证的步骤才标记完成，待新增接口不视为已经实现

## 2 本次明确不做

- 不重新实现 P1 注册、执行、门控、台账或 C++ 行为树引擎
- 不开发 P3 的行为树画布、自由拖拽、子树编辑或端口可视化连线
- 不接入真实视觉、导航、机械臂或 MCU，不修改这些外部仓库
- 不开发相机标定算法、实时图像/点云流、SSH 管理、多主机部署或完整安装向导
- 不新增任务暂停、自动恢复、重置未知状态或清空采摘台账的入口
- 不把当前番茄模拟资产与任务约束放宽成通用真机能力
- 不顺手重构 P1，只对 GUI 所需的接口缺口与共享服务接线做必要增量修改
- 不保留仓库内测试源码，沿用现有工作区外临时验证约束

P3 至 P5 保持原架构路线，不因本计划细化而进入当前进度统计

## 3 当前已完成基线与实际缺口

### 3.1 P1 已完成基线

| 已有能力 | 实际文件或接口 | P2 使用方式 |
|---|---|---|
| 权威契约和参数描述 | `models.py`、`contracts/schema.json`、`contracts/export_schema.py` | 表单读取服务端类型与描述，不另建前端业务 Schema |
| 接入包加载与绑定 | `registry.py` 的 load_package、Registry、bind_system | 草稿校验复用相同规则 |
| 系统生命周期 | `runtime.py`，`/system/start`、`/system/stop`、`/system/status` | GUI 请求管理 API，不执行 shell |
| 已注册包查询与启停 | `/packages`、`/packages/validate`、enable/disable | 复用已有行为，新导入与注册需要增量接口 |
| 本地会话认证 | `api.py`，Bearer 会话、回环入口 | GUI 接入同一认证机制 |
| 控制与操作 | `/control/status`、`/control/take`、`/operations` | 展示模式、错误和停止确认，不靠前端授权 |
| 模拟任务会话 | `tasks.py`、`task_records.py`，`/tasks` 与 status/cancel | 保留任务 ID、幂等请求和节点/操作关联 |
| 冻结任务与系统配置 | Runtime.snapshot、TaskManager._freeze | 编辑草稿不改运行快照 |
| 番茄完整模拟案例 | `examples/tomato_picker/` | 首个 GUI 内置模板 |
| 实际 C++ 引擎 | `task_engine/` | 继续调用已构建的 agro-bt |

原 P1 计划记录了 76 项 Python 验证通过、7 项 CTest 通过与一次 CLI 闭环，演示结果为 SUCCEEDED、16 个操作、停止确认并回到 STOPPED

这些属于上传文件中的历史完成记录，本轮已核对源码和记录，没有重新运行原临时环境，也不把历史结果写成本轮新鲜 PASS

### 3.2 需要在 P2 补齐的缺口

| 实际现状 | P2 必须补齐 | 所属步骤 |
|---|---|---|
| 无 GUI 工程与浏览器启动入口 | 统一界面、会话连接和本地启动 | 1 |
| `/packages/validate` 只校验路径，不导入新包 | 静态导入、草稿包目录和描述查询 | 2 |
| 无系统配置编辑 API | 草稿、后端绑定、表单校验和保存 | 2 |
| Runtime 固定绑定构造时的 config_path，不能切换配置 | 受控停止态应用、结果追踪和 CLI 对等入口 | 3 |
| `/system/start` 与 stop 只返回接受，后台 jobs 未提供独立结果查询 | 管理作业查询，错误与接受/完成分开 | 3 |
| TaskManifest 与标定校验存在，但无模板和资产页面 API | 模板描述、资产导入/校验、参数与预检入口 | 4 |
| 有 tasks/status/cancel，无运行页面 | 总览、任务操作、节点反馈和取消等待 | 5 |
| 有快照、事件与执行器日志，无诊断和导出入口 | 记录页面、有限日志读取、脱敏报告 | 6 |

### 3.3 源码中特别需要保留的边界

- TypeDescriptor 包含单位、坐标系、时间域和有效期，ParameterDescriptor 包含 required、default 与 apply_policy
- 默认值缺省与显式值必须区分，不能由前端无条件补 null 或空字符串
- TaskManifest.kind 当前仅支持 tomato_picker，max_targets 为 1 至 8，恢复次数固定为 0，timeout_ms 有明确范围
- 当前唯一声明的任务可编辑参数为 approach_dz，范围 0.01 至 0.1 m，默认 0.05 m
- XML 中的 max_targets 必须与任务清单一致，P2 不开放独立修改此策略
- 模拟标定当前只支持 camera 至 arm_base 的 X 平移与单位四元数，不能在 GUI 假装支持任意六维标定
- Runtime 构造会锁状态目录并写快照，不能把构造 Runtime 当作无副作用的草稿预检
- TaskManager.status 已含节点、操作、目标、事件和快照，优先复用这些内容
- completed_targets 当前按 system_snapshot_id 过滤，配置切换必须避免已采摘目标因摘要变化重新进入候选
- UNKNOWN 与停止未确认不能通过换配置、创建新目录或重建 TaskManager 绕过

## 4 完成标准

- [x] GUI 以 Electron 独立窗口启动和连接本机 Agent，主题、语言和布局设置独立于机器人配置
- [ ] 不手改 YAML 即可导入受支持描述、添加后端、绑定能力角色、校验和保存系统配置
- [ ] 导入描述不会加载代码，启用适配器仍受 Agent 允许列表限制
- [ ] 明确展示草稿、已保存、待应用和实际生效状态，修改后可查看字段差异
- [ ] 停止态应用配置成功可从 GUI 与 CLI 查询同一结果，失败不会显示成已经生效
- [ ] 运行中、UNKNOWN 或停止未确认时阻止配置切换，不清空旧任务和操作台账
- [ ] 资产页面显示设备、坐标系、校验值、来源与验证状态，错误资产不能启动任务
- [ ] 通过 GUI 配置模板参数、启动系统、开始任务、观察结果、取消任务与停止系统
- [ ] 所有需要等待结果的按钮有统一等待反馈，取消与停止入口不会被遮挡
- [ ] 观察页面关闭或刷新不会结束 Agent 持有的任务，重连后可继续观察
- [ ] 可查看本次运行的配置、资产、节点、目标结果与日志，并导出脱敏报告
- [ ] 至少完成一次实际 C++ 引擎驱动的 GUI 模拟闭环，不把前端假数据当作集成验收

## 5 最低成本验证路径

本阶段使用服务组件验证、前端组件验证、构建和一次实际 Electron 桌面模拟闭环，不安排真机实验

所有验证脚本、截图、浏览器报告、Python 虚拟环境与 C++ 构建放在工作区外临时目录，不新增或保留仓库 `tests/`、测试专用页面或故障注入控件

前端交付正常 package.json、依赖锁文件与应用源码，验证脚本在临时目录通过仓库路径导入，不把测试源码打入生产构建

命令中的 `<临时验证目录>` 和 `<临时构建目录>` 是执行时实际创建的目录，执行报告必须给出真实展开路径与结果

1. 服务端针对本步行为运行临时 pytest 或等价验证
2. 前端执行 `npm --prefix gui run typecheck` 与 `npm --prefix gui run build`
3. 临时桌面自动化脚本验证真实 Agent API 与界面操作
4. 最后复用同一次闭环核对任务快照、目标结果、取消语义与记录页面

涉及 Python/C++ 共享契约时检查 Schema 导出一致，只有修改 C++ 时才重新构建与运行相关 CTest，不为纯布局重复完整 P1 验收

## 6 技术与接口约定

### 6.1 GUI 与本机启动

GUI 以 [SerialArm-Core](https://github.com/Kaede-Rei/SerialArm-Core) 的 `apps/launcher/desktop/` 与 `apps/launcher/renderer/` 为桌面与界面模板，已核对本机源码、深浅主题截图、工作台布局与设置交互

当前 GUI 使用 React、TypeScript、Vite 与普通 CSS，维护 `gui/`，沿用 SerialArm 的主题变量、紧凑标题栏、分组侧栏、卡片表单与独立设置页，工作区内容适配当前 Agent，不修改参考仓库

正式入口使用 Electron 独立桌面窗口，FastAPI 在 `/ui/` 提供窗口内部的构建资源，保留原管理接口路径，界面与本机管理 API 同源，开发模式仅配置本机代理

增加 `agroctl gui open` 与 Linux `launch.sh`，已有 Agent 时打开独立桌面窗口，不再启动第二个 Agent，未运行时使用明确的配置、状态目录与任务引擎参数启动

生产启动使用已构建资源，不在每次打开 GUI 时自动安装依赖、联网下载或重新构建，缺失资源时显示可执行的构建说明

浏览器无权直接读取 Agent 文件系统路径，提供选择本机会话文件或输入会话凭据的连接入口，凭据只驻留内存，不进入 URL、日志、localStorage 或报告

主题、语言与面板布局可保存在桌面设置中，机器人配置与认证凭据不使用该通道

### 6.2 待新增接口

下面仅列建议新增的接口，不替换现有 P1 路由

| 接口 | 职责 |
|---|---|
| `GET /schemas` | 返回由权威模型导出的 Schema 和当前支持类型 |
| `POST /catalog/packages/import`、`GET /catalog/packages` | 静态导入与查询描述目录，区别于当前启用的 `/packages` |
| `POST /configs/drafts`、`GET /configs/drafts/{id}`、`PUT /configs/drafts/{id}` | 创建、读取和修改配置草稿，带 revision 冲突校验 |
| `POST /configs/drafts/{id}/validate`、`GET /configs/drafts/{id}/diff` | 校验并比较当前实际配置 |
| `POST /configs/drafts/{id}/apply` | 接受停止态应用请求，返回 management_job_id |
| `GET /management/jobs/{id}` | 返回管理请求状态、实际阶段、结果与错误 |
| `GET /task-templates`、`GET /task-templates/{id}` | 列出模板和实际可编辑参数 |
| `POST /task-templates/{id}/drafts` | 创建不可覆盖内置模板的任务方案副本 |
| `POST /task-drafts/{id}/validate` | 校验参数、资产、XML 与当前系统兼容性，不产生动作 |
| `POST /assets/import`、`GET /assets`、`POST /assets/{id}/validate` | 内容导入、元数据与验证，保持来源与设备约束 |
| `GET /records/tasks/{id}/logs`、`GET /records/tasks/{id}/report` | 有界日志读取与脱敏报告导出 |

系统 start/stop 的现有响应可增添 management_job_id，保留 P1 字段，CLI 与 GUI 共用查询路径

配置与资产服务由 API 和 CLI 调用同一 Python 实现，不通过调用 agroctl 子进程绕过 API，也不把写配置逻辑仅放到浏览器

## 7 总执行 Prompt

下面内容附加到每个步骤的 Codex Prompt 前面

```text
你正在修改 AT-System-Integration，只完成当前 P2 步骤
先读取 docs/architecture.md、当前计划、原 P1 完成记录，以及本步直接相关源码和配置
如果存在 AGENTS.md 一并读取，本次上传包未包含该文件，不要虚构额外约束
保持现有 Python 代码的组织、命名、异常、日志与注释风格，优先复用 P1 组件
新增前端遵守步骤 1 确定的统一类型、主题与组件风格

禁止重新实现执行器、资源控制、任务状态或创建 CLI 专用业务逻辑
只在本步明确范围内补接口与页面，不修改其他机器人仓库，不提前实施 P3 至 P5
普通源码读取、依赖确认、构建和验收属于实施步骤，不单设分析或文档主步骤

不新建或切换分支，不 commit、push、合并、发布或部署到用户设备
验证脚本、浏览器测试、截图、报告、虚拟环境和构建放在工作区外临时目录
不在仓库新增或保留 tests 目录、测试源码、测试专用 UI 或编译缓存
正常前端依赖清单与锁文件可交付，禁止将会话密钥和本地运行状态打包

新增自然语言、Markdown 和汇报不用中文句号，段落末尾不加句号、逗号、分号、冒号、感叹号或问号
不在新增文案、注释或文档写发布版本号、升级叙事或版本对比
不得破坏依赖、契约兼容性、代码和配置所需语法
当前步骤完成前不提前更新无关 README、CHANGELOG、架构或计划
原 P1 计划归档和本计划进度是明确文档交付，只做必要修改，不覆盖完成证据

HTTP 接受、任务终态、设备停止与配置实际生效分别处理
客户端断线显示状态失去观察，不自动取消任务、不自动重发控制请求
UNKNOWN、停止未确认和资源隔离不允许通过换配置或换台账目录绕过
所有等待按钮使用统一等待组件，取消/停止入口保持可访问

重要代码修改完成前使用 requesting-code-review 若可用
标记完成前使用 verification-before-completion 若可用
只做足以证明本步标准的验证，没有新鲜证据不能写 PASS
新问题不阻塞目标则进入 Later Optional，阻塞则只调整受影响步骤
完成后报告修改文件、实际验证命令、结果、未验证项和需要用户操作的事项
```

## 8 实施步骤

### 步骤 1 `[x]` 建立 GUI 入口与统一界面基础

**目标与修改范围**

创建 `gui/package.json`、TypeScript/Vite 配置与 `gui/src/`，增量修改 `api.py`、`cli.py` 并新增 Electron 主进程、受限 preload 与 `launch.sh`，提供可连接当前 Agent 的独立桌面 GUI

**必做**

- Electron 无边框独立窗口、原生窗口操作与单实例聚焦，零参数 `./launch.sh` 打开，不调用浏览器
- 系统搭建、模板任务、运行调试三个工作区，其中任务画布显示后续阶段占位说明
- 构建共享 ApiClient、主题、语言、状态卡片、表单基础和 PendingDialog
- 服务端静态路由不继承整个页面的 Bearer 依赖，管理 API 继续认证，不能为页面方便关闭 P1 认证
- 登录态只在内存，401 清理凭据并回到连接页，页面刷新后重新连接
- 本步只调用已有 system、packages、control、tasks 的只读接口，展示真实状态与断线时间
- launch 检查目标 endpoint 和 Agent 身份，已运行就连接，不能复用错误项目或任意端口响应
- PendingDialog 显示正在执行与转圈，背景玻璃模糊，保留错误展示、关闭观察和取消/停止操作区域

**禁止**

不写前端模拟执行器，不实现全屏长期不可关闭等待，不加入业务表单或自由树编辑器

**最小验证**

- [x] 仓库内安装 Electron，零参数打开独立窗口，重复打开聚焦已有窗口，关闭窗口保留 Agent
- [x] 连接已有 Agent 不新增进程，身份或配置不匹配时不误连
- [x] 会话凭据不进入地址、持久存储、控制台或报告
- [x] system 状态与 CLI 一致，断线显示未观测，不能把旧绿色状态当作当前可用
- [x] 深浅主题、语言设置和窄屏布局可用，PendingDialog 的操作按钮不被遮挡
- [x] 前端类型检查与构建通过，临时浏览器脚本验证会话与路由

**Codex Prompt**

```text
完成步骤 1，只建设 GUI 入口、同源静态资源、认证客户端和统一组件
复用当前 api.py 与 cli.py，不新建独立 GUI 服务或放宽 API 认证
新增 agroctl gui open 与 launch.sh，连接已有 Agent，缺少构建或执行器时给出明确原因
先以 P1 只读接口展示真实状态，等待组件支持模糊背景、转圈与始终可访问的操作区
验证启动幂等、凭据不持久化、断线和布局，再报告实际命令
```

**完成记录**

- 新增 `gui/` React、TypeScript、Vite 与普通 CSS 工程，三个工作区仅展示现有管理 API 的真实只读状态，任务画布保留后续阶段说明
- 共享 ApiClient、主题与语言设置、状态卡片、表单基础和 PendingDialog，401 清理内存会话，断线移除旧状态并显示最后成功观测时间
- FastAPI 在 `/ui/` 提供无 Bearer 依赖的同源静态资源，现有管理路由继续统一认证，新增受保护的 `/agent/identity` 用于启动握手
- 新增 `agroctl gui open`、`launch.sh` 和 Agent `--ui-dir`，核对项目来源、配置摘要与状态目录，已有 Agent 复用 PID，空闲端口才启动 Agent
- 原 P1 完成计划原样归档，GUI 使用方法见 `gui/README.md`，构建默认输出至 `/tmp/agro-gui-dist`
- 独立代码审查发现观察请求乱序风险，临时浏览器验证先复现旧成功覆盖较新失败，再通过请求代次拒绝过期结果，当前会话的 401 始终清理认证状态

实际验证命令与结果

```bash
/tmp/agro-p2-1-venv/bin/pytest /tmp/agro-p2-1-verification/test_gui.py -q
# 26 passed
npm --prefix gui run typecheck
# PASS
npm --prefix gui run build
# PASS，产物 /tmp/agro-gui-dist
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/launch_checks.py
# PASS，已有 Agent 复用、配置不匹配、错误服务、缺少执行器与构建、自动启动及再次复用
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/browser_full.py
# PASS，真实 Agent 的 7 组会话、状态、断线与布局场景
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/observation_order.py
# PASS，旧成功响应不能覆盖较新的断线状态
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/pending_checks.py
# PASS，错误、玻璃模糊、窄屏取消/停止/关闭、焦点约束与 Escape
bash -n launch.sh
git diff --check
# PASS
```

验证边界与后续事项

- Python 虚拟环境、验证脚本、组件页面、截图和报告均位于 `/tmp/agro-p2-1-*`，仓库未交付测试源码或运行密钥
- 浏览器使用实际 P1 Agent 与实际 CLI 状态，断线和 401 故障只由临时浏览器脚本注入，生产页面没有故障控件
- 自动启动验证只核对 Agent 握手，临时使用 `/usr/bin/true` 满足可执行路径条件，不调用执行器、不启动模块或任务，使用者需指定实际 `agro-bt`
- 使用自定义资源目录的已有 Agent 时，启动入口也需传入相同 `--ui-dir`
- 当前弹窗操作区使用按钮，未来加入选择器或多行输入时需扩展焦点约束范围
- 本步未修改 C++ 或共享契约，未重跑 P1 全量验收或 GUI 采摘闭环，任务与停止操作按后续步骤实施

**入口易用性补充**

- 按用户补充要求新增 `install.sh`，检查工具依赖，创建独立 Python 环境并安装当前包、构建 GUI 和真实 C++ 执行器，不自动 sudo、不启动 Agent 或任务
- 新增 `scripts/local-paths.sh` 统一默认路径，安装产物位于用户数据目录的项目专属目录，安装信息保存在 `installation.json`
- `./launch.sh` 和新增的 `./launch` 均支持无参数打开默认番茄模拟工作区，不再要求激活 Python 环境或传入配置、状态目录和执行器路径
- 原高级参数继续覆盖默认值，原 Agent 身份核对与会话认证保持生效，GUI 配置编辑仍按步骤 2 和步骤 3 实施
- README 与 GUI 使用说明已更新，安装目录可通过 `AGRO_INSTALL_DIR` 显式覆盖

```bash
AGRO_INSTALL_DIR=/tmp/agro-local-install npm_config_cache=/tmp/agro-install-npm-cache PIP_CACHE_DIR=/tmp/agro-install-pip-cache PYTHONDONTWRITEBYTECODE=1 ./install.sh
# PASS，Python 安装、前端类型检查与构建、实际 agro-bt 构建完成
# 同一安装命令重复执行通过，日志 /tmp/agro-p2-1-verification/install-repeat.log
PYTHONDONTWRITEBYTECODE=1 /tmp/agro-p2-1-venv/bin/pytest /tmp/agro-p2-1-verification/test_install_launch.py -q
# 5 passed
PYTHONDONTWRITEBYTECODE=1 /tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/installed_launch.py
# PASS，零参数入口、launch 别名、任意工作目录、独立解释器、PID 复用、实际浏览器认证、未启动模块或任务
/tmp/agro-local-install/task-engine/agro-bt --xml task_engine/examples/bridge.xml --registry contracts/examples/bt.registry.json --validate-only --models /tmp/agro-p2-1-verification/installed-node-models.xml
# valid true
bash -n install.sh launch.sh launch scripts/local-paths.sh
git diff --check
# PASS
```

独立审查未发现阻塞问题，安装和浏览器证据只保留在 `/tmp`，没有向默认用户数据目录执行安装或交付测试源码

按用户最新要求，安装默认位置已改为仓库内 `.install/`，该目录整体忽略 Git 提交，`./launch.sh` 无参数读取其中的环境、GUI、执行器和状态目录，验证脚本与报告仍留在 `/tmp`

```bash
PYTHONDONTWRITEBYTECODE=1 /tmp/agro-p2-1-venv/bin/pytest /tmp/agro-p2-1-verification/test_install_launch.py -q
# 6 passed，包含仓库内默认路径和既有启动行为
bash -n install.sh launch.sh launch scripts/local-paths.sh
git check-ignore .install/venv/bin/python .install/gui/index.html .install/state/session.token
# PASS
```

**SerialArm-Core 模板修正与重新验收**

- 参考本机 SerialArm-Core 提交 `ce19cb5a26df19e6676048ffa29379c48d55177f` 的 renderer 源码及深浅主题截图，采用琥珀色主题、44px 标题栏、224px 桌面侧栏、分组导航、状态栏和卡片工作台
- 保留 React、TypeScript 与当前同源 API，新增独立设置页与系统跟随主题，未引入 Electron 窗口控制或机械臂业务桥接
- 模板授权保存在 `gui/THIRD_PARTY_NOTICES.md`，构建时同步携带授权文件
- 临时浏览器脚本先复现设置页 401 无法返回连接入口的问题，修复后验证清理内存凭据并返回系统连接页
- `.install/gui` 已重新构建，实际零参数 `./launch.sh` 打开修正界面，重复启动复用 PID，浏览器认证后观测真实 Agent 状态
- 独立审查未发现 Critical 或 Important 问题，验证源码、截图与报告均保留在 `/tmp`，仓库不交付测试源码

本轮实际验证命令与结果

```bash
PYTHONDONTWRITEBYTECODE=1 /tmp/agro-p2-1-venv/bin/pytest /tmp/agro-p2-1-verification/test_gui.py /tmp/agro-p2-1-verification/test_install_launch.py -q
# 32 passed
npm --prefix gui run typecheck
npm --prefix gui run build
AGRO_GUI_DIST="$PWD/.install/gui" npm --prefix gui run build
# PASS，临时构建与实际安装资源均更新
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/template_visual.py
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/theme_system.py
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/default_install_gui.py
# PASS，参考主题和布局、系统主题跟随、320px 英文导航、实际 .install 零参数启动与 PID 复用
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/browser_full.py
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/observation_order.py
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/settings_auth.py
/tmp/agro-p2-1-venv/bin/python /tmp/agro-p2-1-verification/pending_checks.py
# PASS，7 组浏览器场景、观察乱序、设置页 401、弹窗操作与焦点约束
```

**Electron 桌面入口修正与重新验收（2026-10-08）**

以上页面版与样式对齐记录保留为历史，正式入口现已改为 Electron 独立桌面窗口，当前入口为 `./launch.sh`，没有 `launch` 别名

- 新增 `gui/desktop/` 主进程、preload 与安装脚本，采用参考仓库的无边框窗口、可拖动标题栏、最小化、最大化/还原和关闭按钮
- 锁定 Electron `44.7.0`，显式下载运行时并安装至 `.install/desktop/`，Node.js 最低版本更新为 22.12，生产启动只读取已安装资源，缺失桌面环境时提示重新安装
- `agroctl gui open` 核对 Agent 后启动独立窗口，默认不调用浏览器，新增 `--desktop-dir` 和诊断选项 `--no-window`，旧 `--no-browser` 作为诊断兼容别名
- 保留管理 API 认证与内存会话，主进程仅允许本机入口和同源资源，preload 只暴露三个固定窗口操作，启用 contextIsolation 与 sandbox，关闭 Node 集成并拒绝外部导航、弹出窗口和权限请求
- 同一状态目录与 Agent 入口复用桌面实例并聚焦，窗口偏好和缓存保存在状态目录的 `desktop/`，窗口关闭不终止 Agent
- 独立审查未发现 Critical 或 Important，发现等待弹窗遮住窗口按钮后，临时真实 Electron 脚本先复现失败，再修正 inert 与覆盖范围并验证通过
- `.install/` 已完整安装并重复安装通过，真实零参数启动、窗口认证、深浅主题、401 返回连接页、刷新重新认证和关闭后 Agent 存活均验证通过
- 本轮验证脚本、临时环境与截图只保留在 `/tmp/agro-desktop-verification`，不向仓库交付测试源码，不扩展 P2-2 功能

本轮实际验证命令与结果

```bash
PYTHONDONTWRITEBYTECODE=1 ./install.sh
# PASS，Python、GUI、Electron 44.7.0 与实际 agro-bt 安装完成，重复执行同样通过
npm --prefix gui run typecheck
AGRO_GUI_DIST="$PWD/.install/gui" npm --prefix gui run build
# PASS
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src /tmp/agro-desktop-verification/venv/bin/python -m pytest /tmp/agro-desktop-verification/test_desktop.py -q
# 9 passed，桌面安装前置检查、参数兼容与入口边界
/tmp/agro-desktop-verification/venv/bin/python /tmp/agro-desktop-verification/launcher_checks.py
/tmp/agro-desktop-verification/venv/bin/python /tmp/agro-desktop-verification/default_launch.py
# PASS，真实 Agent PID 复用、管理 API 认证、未启动模块/任务、实际零参数 Electron 进程
node /tmp/agro-desktop-verification/electron_pending.cjs
node /tmp/agro-desktop-verification/electron-smoke.cjs
# PASS，等待期间窗口操作、隔离、认证、主题、401、刷新、窗口按钮、单实例聚焦、外部导航/弹窗拒绝、关闭保留 Agent
bash -n install.sh launch.sh scripts/local-paths.sh
node --check gui/desktop/main.cjs
node --check gui/desktop/preload.cjs
node --check gui/desktop/install.cjs
git diff --check
# PASS
```

### 步骤 2 `[ ]` 实现接入包导入与系统搭建表单

**前置条件**

步骤 1 已通过，GUI 与当前 Agent 可认证通信

**目标与修改范围**

新增 `src/agro_runtime/configuration.py`，必要时细分描述目录存储，增量修改 `api.py`、`cli.py`、Schema 导出与 `gui/src/pages/SystemBuilder/`

**必做**

- 提供 schemas、catalog 和 drafts 接口，draft 含 id、revision、base_snapshot_id、content 与字段错误
- 复用 load_package、SystemConfig、bind_system 和 runtime_plan 做无动作校验，不构造 Runtime、不加载适配器
- 浏览器上传文件内容，服务端保存受控副本与摘要，不能把浏览器文件名当作 Agent 可读绝对路径
- 参数表单支持字符串、数值、整数、布尔、choices、单位、范围、必填和缺省值
- 角色从已导入能力选择，输入输出契约自动带入，只允许兼容绑定，不手填一套不一致端口
- 运行主机当前只支持本机，其他选项禁用并说明后续阶段，原生配置缺校验器时拒绝应用
- 删除草稿后端同步校验角色引用，删除描述目录项不删除外部源码或现有运行实例
- 目录中相同 capability_id 冲突保持 P1 拒绝语义，不在本阶段修改为任意多实现注册
- 接入包目录、草稿保存与当前运行 registry 区分，导入不等于注册生效或启用
- 草稿修改采用 revision 校验，字段差异在服务端生成，文件依赖与相对路径从受控根目录解析

**禁止**

不建设插件安装商店，不自动授权新适配器，不让前端直接编辑任意 Agent 文件

**最小验证**

- [ ] 导入 package.yaml 后可查看能力并创建系统草稿，导入不会执行入口
- [ ] 数值错误、缺省值、重复能力、删除被引用实例和不兼容角色准确定位字段
- [ ] 两页面并发编辑发生 revision 冲突，不静默覆盖
- [ ] 路径穿越、重复 YAML 键和非有限数字拒绝，配置保存后内容往返一致
- [ ] 临时服务和前端验证通过，类型检查和构建通过

**Codex Prompt**

```text
完成步骤 2，实现静态接入包目录、服务端配置草稿与系统搭建表单
使用 P1 权威模型，默认值缺省不要序列化成 null
预检不得构造 Runtime，上传按内容保存，不接受浏览器本地路径作为服务端路径
明确目录可见、配置引用、实际注册和适配器启用的区别
对草稿引入 revision 与 base_snapshot_id，验证字段错误、兼容绑定和编辑冲突
```

### 步骤 3 `[ ]` 打通配置应用与管理操作追踪

**前置条件**

步骤 2 草稿可保存和校验

**目标与修改范围**

增量修改 `configuration.py`、`api.py`、`runtime.py`、`tasks.py` 与 `cli.py`，必要时新增小型活动运行上下文，GUI 增加差异、应用与生效结果页面

**必做**

- 管理 job 状态与机器人 operation 状态分开，记录 request_id、accepted、phase、result、error 和生效摘要
- 将已有 start/stop 后台异常纳入 job 查询，保留原响应字段，不能再只有 HTTP 202 而没有结束原因
- 应用请求固定草稿 revision 与 base_snapshot_id，Agent 再次校验并串行化配置切换
- 仅在 STOPPED、无活动任务、无 UNKNOWN、无未确认停止、无遗留进程或资源隔离时应用
- 明确 Runtime 和 TaskManager 当前闭包引用关系，切换后所有路由使用同一活动上下文，保留原生命周期锁与状态目录独占
- 预检先静态完成，释放旧实例后再创建新实例，禁止同时持有同一 agent.lock 的两个 Runtime
- 在同一部署状态目录保留操作、任务和目标历史，不通过换目录实现配置切换
- 生效指针仅在新上下文完整创建后发布，失败时恢复可验证旧配置或进入阻塞故障态，报告实际结果
- 配置应用不自动启动系统或任务，也不自动扩大 allowed_entrypoints
- 配置应用成功后持久化默认工作区的活动配置引用，无参数 launch 的重连与重启沿用实际应用配置，不退回初始模拟配置或换状态目录绕过阻塞状态
- 每项显示 apply_policy，P2 对系统配置采用停止态应用，不假装支持已有后端热更新
- 修正或明确保护 completed_targets 的跨快照连续性，同一设备与模拟场景沿用台账，无法证明身份连续的变更拒绝应用，不开放重置按钮
- 增加 CLI config validate/diff/apply/status，共享相同服务与 job

**禁止**

不在运行中替换 engine，不清空 UNKNOWN，不以 HTTP 成功或草稿写入成功当作实际生效

**最小验证**

- [ ] 正常停止态应用后 GUI、CLI 与 system/snapshot 的摘要相同
- [ ] 双重点击、revision 冲突、取消中与 UNKNOWN 均不能产生绕过或重复切换
- [ ] 应用失败后记录真实失败阶段，不出现 GUI 说已生效但 Runtime 仍旧配置
- [ ] 切换后的所有旧路由调用新活动上下文，任务历史仍可查询
- [ ] 已采摘目标不因系统配置摘要变化被重新采摘
- [ ] 用临时状态目录验证失败回退与锁接力，不修改当前主机服务

**Codex Prompt**

```text
完成步骤 3，实现停止态配置应用和 management_job 查询
先核对 api.py 闭包、Runtime 状态目录锁与 TaskManager 持久记录，再做最小活动上下文接线
所有路由和 CLI 共享一份生效配置，应用成功不自动启动
未知状态、未确认停止、旧进程和过期 revision 都必须阻止应用
保留旧台账，专门验证 system_snapshot_id 改变不会清空已采摘过滤
不承诺无条件原子回退，失败时报告真实生效或阻塞状态
```

### 步骤 4 `[ ]` 完成模板参数与标定资产管理

**前置条件**

步骤 3 可应用和查询实际系统配置

**目标与修改范围**

新增 `src/agro_runtime/assets.py`，增量修改 `tasks.py`、`api.py`、Schema 与 CLI，新增 `gui/src/pages/TaskSetup/` 和资产页面

**必做**

- 模板列表读取内置 harvest.xml、harvest.task.json 与布局文件，不改内置原件
- 编辑模板时创建任务方案副本，保存参数与资产引用，XML 拓扑保持原模板
- 复用 ParameterDescriptor 生成参数表单，当前 approach_dz 可编辑，候选上限和恢复次数只读
- 对 TaskManager._freeze 中读取与验证逻辑提取最小公共预检入口，start_task 再次使用同一逻辑
- 预检不创建任务、控制令牌或持久操作，实际开始前重新检查资产与配置摘要
- 资产上传保存原始字节、实际摘要与元数据，禁止用用户输入的 verified 开关创造验证证据
- 展示 device_id、source_frame、target_frame、source、verification、校验值与支持范围
- 模拟资产明确标为模拟，只接受 P1 实际支持的变换，真实手眼标定入口显示尚未接入
- 方案绑定不可变资产副本，改变原上传文件不改现有方案或运行快照
- 提供 CLI 查询与预检入口，不重复创建一套 CLI 资产逻辑

**禁止**

不开放任意六维标定编辑、自动标定算法、物理动作重试或任务 XML 结构编辑

**最小验证**

- [ ] approach_dz 范围与缺省符合清单，空白值不会悄悄覆盖默认值
- [ ] 设备身份、坐标系、摘要和来源不匹配的资产阻止预检和任务启动
- [ ] 非 X 平移等不支持内容明确拒绝，不能只显示绿色导入成功
- [ ] 修改草稿不改内置模板或已经运行任务的资产摘要
- [ ] 临时验证表明预检没有增加任务、操作或控制代次

**Codex Prompt**

```text
完成步骤 4，提供模板描述、任务方案副本、参数表单与资产导入验证
复用 tasks.py 当前冻结规则，提取无动作公共预检，不降低原有校验
保持 tomato_picker 的现有支持边界，恢复次数与树结构不开放修改
导入资产不等于已完成标定，verified 不能由界面勾选制造
验证来源、设备、坐标系、摘要和方案不可变引用，再报告实际结果
```

### 步骤 5 `[ ]` 完成系统总览与任务操作闭环

**前置条件**

步骤 1 至 4 已通过，可通过 GUI 应用配置和校验任务方案

**目标与修改范围**

新增 `gui/src/pages/Runtime/` 与共享等待/观察组件，必要时补充只读就绪查询，不改变 P1 执行与控制语义

**必做**

- 用户流程为选择系统、检查配置与资产、启动系统、开始任务、观察、取消或结束
- 检查页分别呈现进程、接口、数据和授权，读取状态不会调用 control/take 获取 AUTO 权限
- 任务启动使用现有 POST /tasks 与持久 request_id，同一次用户意图重复点击或请求超时后核对相同 ID，不盲目生成新任务
- 显示当前任务 ID、节点、operation_id、反馈、目标结果、错误与独立停止状态
- 定时轮询使用单一有界订阅，页面切换清理观察请求，网络错误保留已知 ID 并显示数据陈旧
- PendingDialog 用于校验、应用、启动、取消、停止等等待操作，模糊背景并显示真实阶段
- 开始任务确认已进入 RUNNING 后关闭启动弹窗，长期任务在运行页持续观察，不能整个作业期间锁死界面
- 取消接受后保持取消中直到真正确认，超时显示停止未确认并保留处理入口，不能一直无限转圈
- 弹窗中的停止/取消保持键盘和鼠标可达，关闭弹窗只停止观察，不自动撤销控制
- 控制接管必须显式操作，UNKNOWN 仅展示核对原因，P2 不提供伪造解除
- 断开 GUI、刷新与重连可重新查询原 task_run_id，未支持的暂停按钮不显示为可用

**禁止**

不让前端判断替代后端门控，不把任务 FAILURE、未知结果与设备停止合并成一个状态

**最小验证**

- [ ] 实际 Agent 与 agro-bt 完成一次 GUI 单果闭环，任务与目标结果对应 P1 语义
- [ ] 启动阶段、执行阶段与取消阶段都有真实反馈，按钮重复点击不重复启动
- [ ] 慢响应、请求结果丢失、取消未确认、GUI 断线和接管场景显示正确
- [ ] 关闭窗口任务继续由 Agent 持有，重连查询同一任务而非新建任务
- [ ] 窄屏、滚动和等待弹窗期间取消/停止入口可访问
- [ ] 复用同一任务核对 GUI 与 CLI 的状态及停止确认一致

**Codex Prompt**

```text
完成步骤 5，使用现有管理接口实现系统总览、任务开始、观察、取消和停止
只做必要只读状态接口，检查页禁止获取控制权
所有等待按钮用统一弹窗，启动确认后回到运行页，取消直到停止确认或明确超时结果
网络超时不等于执行失败，核对原请求 ID，不自动派发新任务
用实际 C++ 引擎完成 GUI 模拟闭环并验证断线、重复点击和停止未确认
```

### 步骤 6 `[ ]` 完成诊断、记录与故障报告页面

**前置条件**

步骤 5 已可运行并观察真实模拟任务

**目标与修改范围**

新增 `src/agro_runtime/diagnostics.py` 与 `gui/src/pages/Records/`，增量修改 `api.py`、`cli.py`，形成可复查和导出的 GUI 使用闭环

**必做**

- 记录页复用 TaskStore、OperationLedger 与冻结快照，展示实际配置、资产、事件、目标和停止结果
- 读取任务 executor.log 时只通过 task_run_id 定位受控路径，限制字节量与偏移，拒绝路径穿越和越界引用
- 模块日志当前未完整捕获，不显示伪终端，也不为此重构所有进程管理器，明确显示该模块日志尚不可用
- 支持复制文本、普通日志选择和错误字段定位，不提供任意远程 shell 执行框
- JSON 报告保存任务与配置摘要、能力绑定、错误、停止状态和相关事件，删除凭据、控制令牌与不必要本机路径
- CLI report 与 GUI 导出共用同一报告生成函数
- 诊断区显示 Agent 不可达、执行器缺失、模块故障、资产失配与未知结果，不把“已连接”当“可执行”
- 将同一次正常任务的运行页、记录页和 CLI 输出关联，不再为报告安排额外采摘实验
- 步骤全部完成后记录 P2 新鲜验收命令与结果，只做本阶段所需的使用入口文档更新

**禁止**

不增加全量 rosbag、云端分析、数据回放或未确认故障的自动修复

**最小验证**

- [ ] 记录页能查询已结束任务，配置和资产摘要与启动时快照一致
- [ ] UNKNOWN、停止未确认与取消失败在界面和导出报告中完整保留
- [ ] 日志读取有界，复制可用，上传名称和日志内容作为文本显示而非执行 HTML
- [ ] 会话文件、控制令牌和日志中的敏感值不进入报告
- [ ] GUI 与 CLI 导出的相同任务报告语义一致
- [ ] 一次浏览器闭环串联配置、资产、运行和记录页，类型检查与构建通过

**Codex Prompt**

```text
完成步骤 6，复用 P1 台账和快照建立记录、日志与脱敏报告页面
新增日志和报告查询只允许受控任务 ID，不接受任意服务端文件路径
当前没有的模块日志明确显示不可用，不建设伪终端或改造所有进程管理器
使用步骤 5 的实际任务核对报告，不增加新的硬件或采摘实验
检查凭据与控制令牌脱敏后按最终验收完成 P2，保留全部真实证据
```

## 9 最终验收

- [ ] 当前六个步骤逐项通过，P1 进度保持已完成
- [ ] 接入描述、系统绑定与参数表单来自同一服务端契约
- [ ] GUI 与 CLI 对配置、任务与报告读写同一管理服务
- [ ] 配置应用不绕过状态目录锁、UNKNOWN、停止未确认或已采摘台账
- [ ] 运行快照、系统草稿和任务方案是不同对象，界面清楚显示归属
- [ ] 等待弹窗具备真实反馈、错误和可访问取消/停止，不制造不可操作遮挡
- [ ] 至少一次实际 Agent/C++ GUI 模拟闭环通过，报告可追溯
- [ ] 全部验证源码与报告位于工作区外，仓库没有新增测试源码和运行密钥
- [ ] P3 可以继续复用模板描述、节点事件与类型数据，不需要推翻本阶段 GUI

### 重点风险对应

| 风险 | 验证步骤 | 期望 |
|---|---|---|
| 上传浏览器路径无法被 Agent 读取 | 2、4 | 按内容导入并管理服务端副本 |
| 应用草稿但闭包仍引用旧 Runtime | 3 | 全路由和 CLI 看到同一实际快照 |
| 换配置重置未知状态或已采摘过滤 | 3、5 | 保留台账与身份连续性，不能绕过 |
| 点击按钮只有 202 导致无限转圈 | 3、5 | 查询管理 job 与实际任务/停止结果 |
| 预检调用 Runtime 构造产生锁与记录副作用 | 2、4 | 静态预检没有执行副作用 |
| 玻璃模糊弹窗遮挡取消/停止 | 1、5 | 操作区持续可访问且可关闭观察 |

## 10 Later Optional

- 桌面应用跨平台发布包与自动更新
- 大型资产缩略图、点云与机械臂模型专用视图
- WebSocket 全量事件推送与复杂高频监控
- 在线插件市场和自动下载后端
- 暂停、断点恢复与用户自定义复杂热更新策略

P3 行为树编辑、P4 真机接入和 P5 远程部署不是可选工程，继续保留原路线，只是不计入当前阶段

## 11 当前立即执行

P2-1 已按 Electron 独立桌面入口重新验收，下一步使用总执行 Prompt 加步骤 2 Codex Prompt 实施静态描述导入与系统草稿，需按用户下一次指令进入该步骤

不要先迁移外部仓库 GUI，也不要因尚未开放任务画布而提前进入 P3

## 12 进度统计

| 阶段或步骤 | 任务 | 状态 |
|---|---|---|
| P1 基线 | 运行核心与模拟闭环 | 已完成，不重复计算 |
| P2-1 | GUI 入口与界面基础 | [x] |
| P2-2 | 描述导入与系统搭建 | [ ] |
| P2-3 | 配置应用与操作追踪 | [ ] |
| P2-4 | 模板参数与标定资产 | [ ] |
| P2-5 | 运行总览与任务操作 | [ ] |
| P2-6 | 诊断、记录与报告 | [ ] |
| 最终验收 | P2 GUI 模拟闭环 | [ ] |

P2 当前 1 / 6，P2-1 已完成 Electron 独立桌面入口与实际安装启动验证
