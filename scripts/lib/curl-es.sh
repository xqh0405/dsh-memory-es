#!/usr/bin/env bash
# 凭据不进 argv 的 curl 封装（S9 巡检 P3）。
#
# 为什么需要：`curl -u "user:pass"` 会把密码放进进程命令行，同机任何用户读
# /proc/<pid>/cmdline 就能拿到。本机单用户时无所谓，但多人共用的宿主机上就不一样了——
# 运维脚本跑在那台机器上，这就成了真实的横向风险。
#
# 做法：把 `user = "..."` 写进一个 600 的临时配置文件（curl --config），密码只在文件里，
# 命令行与 ps 都看不到。**配置文件在函数返回前删除**。
#
# 用法（脚本里先 source 本文件，并保证 $CA 已设置）：
#   es_curl "elastic:$PASS" -H 'Content-Type: application/json' -X PUT "$ES/foo" -d @-
#   es_curl "$READ_USER:$READ_PASS" -o /dev/null -w '%{http_code}' -I "$ES/$idx"
#
# 注意：不要把 `-K -` / `--config -` 交给调用方自己用（stdin 要留给 -d @- 的 heredoc）。

# 超时兜底：运维脚本宁可失败也不要静默挂住（历史坑：curl -X HEAD 会等永远不来的 body）
: "${ES_CURL_TIMEOUT:=15}"

es_curl() {
  local cred=$1
  shift
  if [ -z "${CA:-}" ]; then
    echo 'es_curl: 调用前必须先设置 $CA（CA 证书路径）' >&2
    return 2
  fi
  local cfg
  cfg=$(mktemp "${TMPDIR:-/tmp}/es-curl-XXXXXX") || {
    echo 'es_curl: 无法创建临时配置文件' >&2
    return 2
  }
  chmod 600 "$cfg"
  # 双引号里转义 \ 与 " ：密码是 base64 字母数字，理论上不需要，但不该假设
  local escaped=${cred//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  printf 'user = "%s"\n' "$escaped" >"$cfg"

  local rc=0
  curl -sS --max-time "$ES_CURL_TIMEOUT" --cacert "$CA" --config "$cfg" "$@" || rc=$?
  rm -f "$cfg"
  return "$rc"
}
