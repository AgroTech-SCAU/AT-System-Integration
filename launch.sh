#!/usr/bin/env bash
set -euo pipefail
project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_directory"
# endpoint 与 session-file 位于全局选项，其他选项传给 gui open
source "$project_directory/scripts/local-paths.sh"
if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
    printf '%s\n' '用法: ./launch.sh [--config PATH] [--state-dir PATH] [--task-engine PATH] [--ui-dir PATH] [--desktop-dir PATH] [--endpoint URL] [--session-file PATH] [--no-window]' '首次执行 ./install.sh，之后无需参数即可打开独立桌面窗口'
    exit 0
fi
if [[ ! -x "$python_executable" ]]; then
    printf '%s\n' '尚未安装本机环境，请先执行 ./install.sh' >&2
    exit 1
fi
global_options=()
gui_options=(--config "$default_configuration" --state-dir "$state_directory"
             --task-engine "$engine_executable" --ui-dir "$gui_directory" --desktop-dir "$desktop_directory")
while [[ $# -gt 0 ]]; do
    case "$1" in
        --endpoint|--session-file)
            [[ $# -ge 2 ]] || { printf '%s\n' '缺少全局选项值' >&2; exit 2; }
            global_options+=("$1" "$2")
            shift 2
            ;;
        *) gui_options+=("$1"); shift ;;
    esac
done
exec "$python_executable" -m agro_runtime.cli "${global_options[@]}" gui open "${gui_options[@]}"
