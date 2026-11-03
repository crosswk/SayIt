#!/bin/zsh
# 用独立的测试目录启动本地构建的 SayIt：设置、数据库、日志、登录项都写进测试目录，
# 不碰你自己的 ~/Library。
#
# 用法：scripts/macos/run-test.sh [release|debug] [--reset]
#   release（默认）：src-tauri/target/release/bundle/macos/SayIt.app（build-release.sh 的产物）
#   debug：src-tauri/target/debug/bundle/macos/SayIt.app（npx tauri build --debug --bundles app 的产物）
#   --reset：先清空测试目录，从全新安装（欢迎引导）开始
#
# 测试目录默认是仓库旁边的 test-home/，可以用环境变量 SAYIT_TEST_HOME 换。
# 用 open 启动而不是直接执行二进制：这样「辅助功能」「麦克风」授权记在 SayIt 名下，
# 而不是记在终端名下。
set -euo pipefail

SCRIPT_DIR=${0:A:h}
CLIENT_DIR=${SCRIPT_DIR:h:h}
REPO_DIR=${CLIENT_DIR:h}

PROFILE=release
RESET=0
for arg in "$@"; do
  case "$arg" in
    release|debug) PROFILE=$arg ;;
    --reset) RESET=1 ;;
    *) echo "用法：$0 [release|debug] [--reset]"; exit 1 ;;
  esac
done

APP="$CLIENT_DIR/src-tauri/target/$PROFILE/bundle/macos/SayIt.app"
if [ ! -d "$APP" ]; then
  echo "找不到 $APP"
  echo "先构建：release 跑 scripts/macos/build-release.sh，debug 跑 npx tauri build --debug --bundles app"
  exit 1
fi

TEST_HOME="${SAYIT_TEST_HOME:-${REPO_DIR:h}/test-home}"

# 已经在跑的本地构建先退出：否则 open 只会把旧实例调到前台，新的 HOME 不生效
if pgrep -f "$APP/Contents/MacOS/sayit" >/dev/null; then
  echo "退出正在运行的测试实例……"
  pkill -f "$APP/Contents/MacOS/sayit" || true
  sleep 1
fi

# 标记文件：只清空由本脚本建的目录，防止 SAYIT_TEST_HOME 指错地方时误删
MARKER=".sayit-test-home"
if [ "$RESET" = 1 ] && [ -d "$TEST_HOME" ]; then
  if [ ! -f "$TEST_HOME/$MARKER" ]; then
    echo "$TEST_HOME 里没有 $MARKER，不像是测试目录，拒绝清空"
    exit 1
  fi
  echo "清空测试目录 $TEST_HOME"
  rm -rf -- "$TEST_HOME"
fi
mkdir -p "$TEST_HOME"
touch "$TEST_HOME/$MARKER"

open --env "HOME=$TEST_HOME" "$APP"

echo "已启动：$APP"
echo "测试目录：$TEST_HOME"
echo "日志：$TEST_HOME/Library/Application Support/com.sayit.app/logs/sayit.log"
echo "退出：点菜单栏的 SayIt 图标 → 退出"
