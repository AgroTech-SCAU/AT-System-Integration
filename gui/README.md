# 桌面工作台

桌面工作台用于接入 ROS2 子系统、配置任务、编排流程和查看运行结果，具体操作见 [工作台使用指南](../docs/interactive-guide.md)

## 启动

在仓库根目录安装并启动

```bash
./install.sh
./launch.sh
```

已有机器人工程可在启动时指定目录

```bash
./launch.sh --profile /path/to/robot-profile
```

打开工程后先编辑配置，启动设备和执行工作流在运行台发起

## 页面导航

- 机器人选择器用于新建、打开和切换工程
- 机器人页面管理子系统工作区、运行依赖、启动来源与通信配置
- 任务库编辑消息参数、完成判定和任务输入输出
- 流程编排通过层级状态机或行为树组织任务
- 运行台准备所需子系统、执行工作流并查看诊断和记录

工程目录、旧文件导入、离线创建任务与数据映射的步骤集中在 [工作台使用指南](../docs/interactive-guide.md)

## 开发入口

界面使用 React 和 Electron，本地运行核心负责配置管理、能力注册、任务调度与安全停止

- [src](src) 包含页面、控件、导航及中英文文案
- [desktop](desktop) 包含桌面窗口、文件选择与本机桥接
- [package.json](package.json) 定义前端依赖和开发、构建入口
- [vite.config.ts](vite.config.ts) 配置开发代理与界面资源输出
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 记录 GUI 参考来源与授权
