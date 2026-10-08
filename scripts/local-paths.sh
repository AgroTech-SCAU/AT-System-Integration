#!/usr/bin/env bash
# 安装与启动共用仓库内忽略提交的本机目录
installation_directory="${AGRO_INSTALL_DIR:-$project_directory/.install}"
if [[ "$installation_directory" != /* ]]; then
    installation_directory="$project_directory/$installation_directory"
fi
python_executable="${AGRO_PYTHON:-$installation_directory/venv/bin/python}"
gui_directory="${AGRO_GUI_DIST:-$installation_directory/gui}"
engine_executable="$installation_directory/task-engine/agro-bt"
desktop_directory="$installation_directory/desktop"
state_directory="$installation_directory/state"
default_configuration="$project_directory/examples/workspace/system.yaml"
if [[ "$gui_directory" != /* ]]; then
    gui_directory="$project_directory/$gui_directory"
fi
if [[ -n "${AGRO_PYTHON:-}" && "$python_executable" != */* ]]; then
    python_executable="$(command -v "$python_executable" || true)"
fi
