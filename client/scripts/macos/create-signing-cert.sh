#!/bin/zsh
# 在「登录」钥匙串里创建一张自签名的代码签名证书（默认名「SayIt Self-Signed」，有效期 10 年）。
#
# 为什么要它：macOS 的「辅助功能」授权绑定在代码签名上。ad-hoc 签名每次构建都是新身份，
# 用户每次更新后都得重新勾选；用同一张证书签每个版本，授权会一直保留。
# 自签名证书不能公证，用户第一次打开仍要在「隐私与安全性」里点「仍要打开」（见 dev-docs/macos-port/README.md）。
#
# 用法：scripts/macos/create-signing-cert.sh ["证书名"]
# 过程中系统可能弹窗要登录密码（把证书设为「代码签名时始终信任」）。
# ⚠️ 证书和私钥只在这台 Mac 的钥匙串里；换机器发版前用「钥匙串访问」导出 .p12 备份，
#    丢了就只能换新证书，所有用户要重新授权一次。
set -euo pipefail

NAME="${1:-SayIt Self-Signed}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "钥匙串里已经有「$NAME」，不重复创建。"
  security find-identity -p codesigning "$KEYCHAIN" | grep "$NAME" || true
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cert.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = $NAME
[ ext ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$WORK/cert.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1

PASS=$(/usr/bin/openssl rand -hex 16)
/usr/bin/openssl pkcs12 -export -name "$NAME" \
  -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/cert.p12" -passout "pass:$PASS"

security import "$WORK/cert.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign

echo "把证书设为「代码签名时始终信任」，系统可能要求输入登录密码……"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

echo
echo "完成。可用的签名身份："
security find-identity -v -p codesigning "$KEYCHAIN" | grep "$NAME" || {
  echo "⚠️ 没在有效身份里看到「$NAME」，请打开「钥匙串访问」确认这张证书的信任设置。"
  exit 1
}
