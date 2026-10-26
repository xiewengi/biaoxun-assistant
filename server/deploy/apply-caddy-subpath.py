#!/usr/bin/env python3
"""把标讯助手挂到现有 Caddy 站点的子路径下（默认 /biaoxun/）。

只在 Caddyfile 的「站点块」末尾插入 4 行路由，不改动其他内容；带备份、
语法校验（caddy validate）与失败回滚。可用于没有域名的 IP 直连场景。

用法（服务器上 root 执行）：
    python3 apply-caddy-subpath.py --dry-run          # 只看会插入什么
    python3 apply-caddy-subpath.py                    # 备份 + 插入 + 校验
    python3 apply-caddy-subpath.py --reload           # 插入后 systemctl reload caddy
    python3 apply-caddy-subpath.py --caddyfile /etc/caddy/Caddyfile \\
        --prefix /biaoxun --upstream 127.0.0.1:8000

退出码：0 成功/已配置；1 参数或结构错误；2 校验失败（原文件未改）。
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple


def strip_comment(line: str) -> str:
    """去掉行内 # 注释（忽略引号内的 #）。"""
    out = []
    in_quote = False
    escaped = False
    for ch in line:
        if escaped:
            out.append(ch)
            escaped = False
            continue
        if ch == "\\":
            out.append(ch)
            escaped = True
            continue
        if ch == '"':
            in_quote = not in_quote
            out.append(ch)
            continue
        if ch == "#" and not in_quote:
            break
        out.append(ch)
    return "".join(out)


def brace_delta(line: str) -> int:
    """统计一行中（忽略引号）的 { } 净值。"""
    code = strip_comment(line)
    in_quote = False
    escaped = False
    delta = 0
    for ch in code:
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_quote = not in_quote
            continue
        if in_quote:
            continue
        if ch == "{":
            delta += 1
        elif ch == "}":
            delta -= 1
    return delta


def find_site_blocks(lines: List[str]) -> List[Tuple[int, int, str]]:
    """返回 [(start, end, header)]，start/end 均为 0-based 行号。"""
    blocks: List[Tuple[int, int, str]] = []
    depth = 0
    start: Optional[int] = None
    header = ""
    for idx, line in enumerate(lines):
        code = strip_comment(line).strip()
        if start is None and depth == 0 and "{" in code:
            start = idx
            header = code
        depth += brace_delta(line)
        if start is not None and depth == 0:
            blocks.append((start, idx, header))
            start = None
            header = ""
    if depth != 0:
        raise ValueError("Caddyfile 花括号不配对（depth=%d）" % depth)
    return blocks


def choose_block(blocks: List[Tuple[int, int, str]]) -> Tuple[int, int, str]:
    """优先选 443/80 的站点块；跳过全局 options 块（header 为 '{'）。"""
    candidates = [
        block for block in blocks if block[2].strip() not in ("{", "")
    ]
    if not candidates:
        raise ValueError("没有找到站点块（只有全局 options 或空文件）")

    def score(block: Tuple[int, int, str]) -> int:
        header = block[2]
        if ":443" in header or "https://" in header:
            return 3
        if ":80" in header or "http://" in header:
            return 2
        return 1

    best = max(candidates, key=score)
    if score(best) == 1 and len(candidates) > 1:
        # 没有明显 443/80 时，选块体最大的那个（通常是主站点）
        best = max(candidates, key=lambda b: b[1] - b[0])
    return best


def build_snippet(prefix: str, upstream: str, indent: str) -> List[str]:
    """用 route + strip_prefix，确保排在现有站点的兜底 reverse_proxy/file_server 之前。"""
    return [
        indent + "# 标讯助手：%s/ → %s（由 apply-caddy-subpath.py 添加）" % (prefix, upstream),
        indent + "redir %s %s/ 308" % (prefix, prefix),
        indent + "route %s/* {" % prefix,
        indent + "\turi strip_prefix %s" % prefix,
        indent + "\treverse_proxy %s" % upstream,
        indent + "}",
    ]


def apply(args: argparse.Namespace) -> int:
    caddyfile = Path(args.caddyfile)
    if not caddyfile.is_file():
        print("❌ 找不到 Caddyfile：%s" % caddyfile, file=sys.stderr)
        return 1
    text = caddyfile.read_text(encoding="utf-8")
    if args.prefix in text:
        print("✅ Caddyfile 已包含 %s，无需修改" % args.prefix)
        return 0

    lines = text.splitlines()
    blocks = find_site_blocks(lines)
    start, end, header = choose_block(blocks)
    closing = lines[end]
    closing_indent = closing[: len(closing) - len(closing.lstrip())]
    indent = closing_indent + "\t"
    snippet = build_snippet(args.prefix, args.upstream, indent)

    new_lines = lines[:end] + snippet + lines[end:]
    new_text = "\n".join(new_lines) + ("\n" if text.endswith("\n") else "")

    print("目标站点块：第 %d-%d 行  %s" % (start + 1, end + 1, header.strip()))
    print("将插入以下内容：")
    print("\n".join(snippet))
    if args.dry_run:
        print("\n（--dry-run：未写入文件）")
        return 0

    with tempfile.NamedTemporaryFile(
        "w", suffix=".Caddyfile", delete=False, encoding="utf-8"
    ) as tmp:
        tmp.write(new_text)
        tmp_path = Path(tmp.name)

    caddy = shutil.which("caddy")
    if caddy:
        proc = subprocess.run(
            [caddy, "validate", "--config", str(tmp_path), "--adapter", "caddyfile"],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            print("❌ caddy validate 未通过，原文件未修改：", file=sys.stderr)
            print((proc.stdout or "") + (proc.stderr or ""), file=sys.stderr)
            tmp_path.unlink(missing_ok=True)
            return 2
        print("✅ caddy validate 通过")
    else:
        print("⚠️  未找到 caddy 命令，跳过语法校验")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = caddyfile.with_name(caddyfile.name + ".bak." + stamp)
    shutil.copy2(caddyfile, backup)
    shutil.copy2(tmp_path, caddyfile)
    tmp_path.unlink(missing_ok=True)
    print("✅ 已写入 %s（备份：%s）" % (caddyfile, backup))

    if args.reload:
        if not caddy:
            print("⚠️  未找到 caddy 命令，无法 reload；请手动 systemctl reload caddy")
            return 0
        proc = subprocess.run(["systemctl", "reload", "caddy"], capture_output=True, text=True)
        if proc.returncode != 0:
            print("❌ reload caddy 失败，可用备份回滚：", file=sys.stderr)
            print((proc.stdout or "") + (proc.stderr or ""), file=sys.stderr)
            return 2
        print("✅ caddy 已 reload")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="给现有 Caddy 站点加标讯助手子路径路由")
    parser.add_argument("--caddyfile", default="/etc/caddy/Caddyfile")
    parser.add_argument("--prefix", default="/biaoxun")
    parser.add_argument("--upstream", default="127.0.0.1:8000")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    args.prefix = "/" + args.prefix.strip("/")
    if not re.match(r"^/[A-Za-z0-9._-]+$", args.prefix):
        print("❌ prefix 只能包含字母数字._-", file=sys.stderr)
        return 1
    try:
        return apply(args)
    except ValueError as exc:
        print("❌ %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
