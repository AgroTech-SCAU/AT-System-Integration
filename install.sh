#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_directory"
bt_source=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            printf '%s\n' '用法: ./install.sh [--bt-source 已下载的BehaviorTree.CPP源码目录]' '默认安装到仓库内 .install/，AGRO_INSTALL_DIR 可指定其他位置' '完成后直接执行 ./launch.sh，无需激活环境或填写路径'
            exit 0 ;;
        --bt-source)
            [[ $# -ge 2 ]] || { printf '%s\n' '--bt-source 缺少目录' >&2; exit 2; }
            bt_source="$2"; shift 2 ;;
        *) printf '%s\n' "未知选项: $1" >&2; exit 2 ;;
    esac
done
for dependency in python3 node npm cmake c++ pkg-config; do
    command -v "$dependency" >/dev/null || { printf '%s\n' "缺少依赖: $dependency，请先安装该工具" >&2; exit 1; }
done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "需要 Python 3.10 或更高")'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!((major === 22 && minor >= 12) || major >= 24)) { console.error("需要 Node.js 22.12 或更高受支持环境"); process.exit(1) }'
pkg-config --exists libcurl || { printf '%s\n' '缺少 libcurl 开发包，Ubuntu 可执行 sudo apt install libcurl4-openssl-dev' >&2; exit 1; }
source "$project_directory/scripts/local-paths.sh"
# 安装只创建依赖环境和构建资源，不启动 Agent、模块或任务
trap 'printf "%s\n" "安装未完成，请处理上方错误后重新执行 ./install.sh" >&2' ERR
mkdir -p "$installation_directory"
if [[ ! -x "$installation_directory/venv/bin/python" ]]; then
    python3 -m venv "$installation_directory/venv"
fi
"$installation_directory/venv/bin/python" -m pip install -e "$project_directory"
npm --prefix "$project_directory/gui" ci
# Electron 44 的 npm 包需显式安装二进制运行时
ELECTRON_GET_USE_PROXY=1 node "$project_directory/gui/node_modules/electron/install.js"
npm --prefix "$project_directory/gui" run typecheck
AGRO_GUI_DIST="$gui_directory" npm --prefix "$project_directory/gui" run build
node "$project_directory/gui/desktop/install.cjs" "$desktop_directory"
cmake_options=()
if [[ -n "$bt_source" ]]; then
    [[ -d "$bt_source" ]] || { printf '%s\n' 'BehaviorTree.CPP 源码目录不存在' >&2; exit 1; }
    bt_source="$(cd -- "$bt_source" && pwd)"
    cmake_options+=("-DFETCHCONTENT_SOURCE_DIR_BEHAVIORTREE_CPP=$bt_source")
fi
cmake -S "$project_directory/task_engine" -B "$installation_directory/task-engine" "${cmake_options[@]}"
cmake --build "$installation_directory/task-engine" --parallel "${AGRO_BUILD_JOBS:-2}"
"$installation_directory/venv/bin/python" - "$installation_directory" "$project_directory" "$gui_directory" <<'PY'
import json
import sys
from pathlib import Path
installation, project, gui = sys.argv[1:]
root = Path(installation)
data = {'project_directory': project, 'python': str(root / 'venv/bin/python'),
        'task_engine': str(root / 'task-engine/agro-bt'), 'ui_directory': gui,
        'state_directory': str(root / 'state'), 'desktop_directory': str(root / 'desktop'),
        'config': str(Path(project) / 'examples/tomato_picker/system.yaml')}
path = root / 'installation.json'
temporary = path.with_suffix('.tmp')
temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
temporary.replace(path)
PY
printf '%s\n' "安装完成: $installation_directory" '现在执行 ./launch.sh 即可打开 GUI'
