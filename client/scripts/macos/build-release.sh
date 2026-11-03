#!/bin/zsh
# 构建 macOS 发布包：
#   - SayIt_<版本>_<架构>.dmg  给用户下载安装
#   - SayIt_<版本>_<架构>.zip  + latest.yml  给自动更新（放到服务器 releases/darwin/<架构>/）
#
# 用法：scripts/macos/build-release.sh
# 环境变量：
#   SAYIT_SIGN_IDENTITY  签名证书名，默认「SayIt Self-Signed」（先跑 create-signing-cert.sh）；
#                        找不到就退回 ad-hoc 签名（能用，但用户每次更新都要重新授权辅助功能）。
set -euo pipefail

SCRIPT_DIR=${0:A:h}
CLIENT_DIR=${SCRIPT_DIR:h:h}
cd "$CLIENT_DIR"
[ -f "$HOME/.local/sayit-dev-env.sh" ] && source "$HOME/.local/sayit-dev-env.sh"

VERSION=$(node -p "require('./package.json').version")
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "不支持的架构：$(uname -m)"; exit 1 ;;
esac

IDENTITY="${SAYIT_SIGN_IDENTITY:-SayIt Self-Signed}"
if security find-identity -v -p codesigning | grep -q "\"$IDENTITY\""; then
  export APPLE_SIGNING_IDENTITY="$IDENTITY"
  echo "签名证书：$IDENTITY"
else
  export APPLE_SIGNING_IDENTITY="-"
  echo "⚠️ 没找到签名证书「$IDENTITY」，改用 ad-hoc 签名。"
  echo "   ad-hoc 签名的版本每次更新后，用户都要重新勾选「辅助功能」。先运行 scripts/macos/create-signing-cert.sh。"
fi

npx tauri build --bundles app,dmg

BUNDLE=src-tauri/target/release/bundle
APP="$BUNDLE/macos/SayIt.app"
DMG=$(ls -t "$BUNDLE"/dmg/*.dmg | head -n 1)
OUT="dist-macos/$VERSION"
ZIP_NAME="SayIt_${VERSION}_${ARCH}.zip"
DMG_NAME="SayIt_${VERSION}_${ARCH}.dmg"
mkdir -p "$OUT"

# 发布物一律从一份不带扩展属性的干净拷贝生成，不直接用构建目录里那份 .app：
# 它签完名以后，Finder 或 iCloud「桌面与文稿」同步还可能往 .app 根目录写 com.apple.FinderInfo
# 之类的扩展属性（codesign 管这叫 detritus），codesign --strict 校验不过，Tauri 打的 dmg 里也会带上。
# 签名本身不依赖扩展属性，去掉不影响签名。
WORK=$(mktemp -d /tmp/sayit-release.XXXXXX)
MNT="$WORK/mnt"
MOUNTED=0
detach_dmg() {
  local i
  # Spotlight 正在索引时卸载会报「资源忙」，等一下再试，最后才强制卸载
  for i in 1 2 3; do
    if /usr/bin/hdiutil detach -quiet "$MNT"; then
      MOUNTED=0
      return 0
    fi
    sleep 2
  done
  /usr/bin/hdiutil detach -quiet -force "$MNT"
  MOUNTED=0
}
cleanup() {
  if (( MOUNTED )); then detach_dmg || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

/usr/bin/ditto --norsrc --noextattr "$APP" "$WORK/SayIt.app"
/usr/bin/codesign --verify --deep --strict "$WORK/SayIt.app"

# zip 给自动更新用。ditto 会保留 .app 里的符号链接和签名；zip 命令会弄坏签名。
# --norsrc --noextattr：不把扩展属性打成 ._ 文件，换别的解压工具也不会在包里多出文件、破坏签名。
/usr/bin/ditto -c -k --norsrc --noextattr --keepParent "$WORK/SayIt.app" "$OUT/$ZIP_NAME"

# dmg 沿用 Tauri 打好的那个（窗口布局、卷图标、「应用程序」快捷方式都在里面），
# 只就地清掉里面 .app 的扩展属性，再压缩、签名。就地清理不会在卷里留下旧文件的空闲块，dmg 不会变大。
# xattr -c 清不掉 com.apple.provenance（系统保护，会静默保留），codesign 也不管它。
/usr/bin/hdiutil convert -quiet "$DMG" -format UDRW -o "$WORK/rw.dmg"
mkdir "$MNT"
/usr/bin/hdiutil attach -quiet -nobrowse -noautoopen -noverify -mountpoint "$MNT" "$WORK/rw.dmg"
MOUNTED=1
/usr/bin/xattr -cr "$MNT/SayIt.app"
/usr/bin/codesign --verify --deep --strict "$MNT/SayIt.app"
# 挂载期间系统写进卷里的事件日志，和 Tauri 打包时一样删掉（可能删不掉，不影响使用）
rm -rf "$MNT/.fseventsd" 2>/dev/null || true
detach_dmg
/usr/bin/hdiutil convert -quiet "$WORK/rw.dmg" -format UDZO -ov -o "$OUT/$DMG_NAME"
# ad-hoc 时不签 dmg：dmg 本身不需要签名，要紧的是里面的 .app
if [ "$APPLE_SIGNING_IDENTITY" != "-" ]; then
  /usr/bin/codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$OUT/$DMG_NAME"
  /usr/bin/codesign --verify "$OUT/$DMG_NAME"
fi

# manifest 里的 sha512 是 Base64（与 Windows 的 latest.yml 相同，客户端按 Base64 比对）
SHA512=$(/usr/bin/openssl dgst -sha512 -binary "$OUT/$ZIP_NAME" | /usr/bin/base64)
SIZE=$(stat -f %z "$OUT/$ZIP_NAME")
DATE=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
cat > "$OUT/latest.yml" <<EOF
version: $VERSION
files:
  - url: $ZIP_NAME
    sha512: $SHA512
    size: $SIZE
path: $ZIP_NAME
sha512: $SHA512
releaseDate: '$DATE'
EOF

echo
echo "产物在 $CLIENT_DIR/$OUT ："
ls -la "$OUT"
echo
echo "发布："
echo "  1. $DMG_NAME 上传到 GitHub Release，给用户下载"
echo "  2. $ZIP_NAME 和 latest.yml 放到服务器的 releases/darwin/$ARCH/ 下，客户端自动更新从这里取"
