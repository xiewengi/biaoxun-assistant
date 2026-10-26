"""Caddy 子路径插入脚本测试（纯本地，不依赖 caddy 二进制）。

脚本位于 server/deploy/apply-caddy-subpath.py，这里用子进程方式验证：
- --dry-run 不写文件；
- 插入位置在 443 站点块内、且不改动全局 options 块；
- 幂等（已存在 /biaoxun 时不再插入）；
- 花括号出现在注释/引号里不会打乱区块识别；
- 没有站点块时明确失败。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "apply-caddy-subpath.py"

SAMPLE = """{
\temail admin@example.com
}

:443 {
\ttls internal
\treverse_proxy 127.0.0.1:5000
}

:80 {
\tredir https://{host}{uri} permanent
}
"""


def run_script(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def write(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "Caddyfile"
    path.write_text(content, encoding="utf-8")
    return path


def test_dry_run_does_not_modify(tmp_path):
    path = write(tmp_path, SAMPLE)
    before = path.read_text()
    proc = run_script("--caddyfile", str(path), "--dry-run")
    assert proc.returncode == 0, proc.stderr
    assert "将插入以下内容" in proc.stdout
    assert path.read_text() == before


def test_apply_inserts_into_443_block(tmp_path):
    path = write(tmp_path, SAMPLE)
    proc = run_script("--caddyfile", str(path))
    assert proc.returncode == 0, proc.stderr
    text = path.read_text()
    assert "route /biaoxun/* {" in text
    assert "uri strip_prefix /biaoxun" in text
    assert "reverse_proxy 127.0.0.1:8000" in text

    # 必须插在 :443 块内，而不是全局 options 或 :80 块
    start_443 = text.index(":443 {")
    end_443 = text.index(":80 {")
    assert start_443 < text.index("route /biaoxun/* {") < end_443
    assert text.index("route /biaoxun/* {") > text.index("reverse_proxy 127.0.0.1:5000")

    # 生成备份
    assert list(tmp_path.glob("Caddyfile.bak.*"))


def test_apply_is_idempotent(tmp_path):
    path = write(tmp_path, SAMPLE)
    assert run_script("--caddyfile", str(path)).returncode == 0
    once = path.read_text()
    proc = run_script("--caddyfile", str(path))
    assert proc.returncode == 0
    assert "无需修改" in proc.stdout
    assert path.read_text() == once


def test_braces_in_quotes_and_comments_do_not_break_block_selection(tmp_path):
    content = """{
\t# 全局配置 { 这里的花括号是注释
\temail "admin@example.com"
}

:443 {
\ttls internal
\theader X-Demo "{not-a-brace}"
\t# 注释里的 } 也不能算数
\treverse_proxy 127.0.0.1:5000
}
"""
    path = write(tmp_path, content)
    proc = run_script("--caddyfile", str(path))
    assert proc.returncode == 0, proc.stderr
    text = path.read_text()
    # 路由必须在站点块闭合之前
    assert text.rstrip().endswith("}")
    assert text.index("route /biaoxun/* {") < text.rindex("}")
    assert 'header X-Demo "{not-a-brace}"' in text


def test_no_site_block_fails(tmp_path):
    path = write(tmp_path, "# 只有一个注释\n")
    proc = run_script("--caddyfile", str(path))
    assert proc.returncode == 1
    assert "没有找到站点块" in proc.stderr
    assert path.read_text() == "# 只有一个注释\n"


def test_invalid_prefix_rejected(tmp_path):
    path = write(tmp_path, SAMPLE)
    proc = run_script("--caddyfile", str(path), "--prefix", "../evil")
    assert proc.returncode == 1
    assert "prefix" in proc.stderr
