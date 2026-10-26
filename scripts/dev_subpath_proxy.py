"""本地子路径反代（模拟 Caddy 的 /biaoxun/* -> 127.0.0.1:8000）。

仅用于开发/部署前验证「标讯助手挂在子路径下」是否正常：
    python3 scripts/dev_subpath_proxy.py --prefix /biaoxun --upstream 127.0.0.1:8000 --port 8032

规则与 Caddy `handle_path /biaoxun/*` 一致：
- /biaoxun            → 308 跳到 /biaoxun/
- /biaoxun/<path>     → 去掉前缀后转发到 upstream 的 /<path>
- 其余路径            → 404（真实 Caddy 里会交给现有站点处理）
"""
from __future__ import annotations

import argparse
import http.server
import socketserver
import sys
import urllib.error
import urllib.request

PREFIX = "/biaoxun"
UPSTREAM = "127.0.0.1:8000"
HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _redirect(self) -> None:
        self.send_response(308)
        self.send_header("Location", PREFIX + "/")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _proxy(self) -> None:
        path = self.path
        if path == PREFIX:
            self._redirect()
            return
        if not path.startswith(PREFIX + "/"):
            self.send_error(404, "only %s/* is proxied" % PREFIX)
            return

        upstream_path = path[len(PREFIX):] or "/"
        body_len = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(body_len) if body_len else None

        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_HEADERS
        }
        headers["X-Forwarded-Prefix"] = PREFIX
        req = urllib.request.Request(
            "http://%s%s" % (UPSTREAM, upstream_path),
            data=body,
            headers=headers,
            method=self.command,
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                payload = resp.read()
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() not in HOP_HEADERS:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            self.send_response(exc.code)
            for key, value in exc.headers.items():
                if key.lower() not in HOP_HEADERS:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as exc:  # noqa: BLE001
            msg = ("upstream error: %s" % exc).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    do_GET = _proxy
    do_POST = _proxy
    do_PATCH = _proxy
    do_PUT = _proxy
    do_DELETE = _proxy
    do_HEAD = _proxy


def main() -> None:
    global PREFIX, UPSTREAM
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default="/biaoxun")
    parser.add_argument("--upstream", default="127.0.0.1:8000")
    parser.add_argument("--port", type=int, default=8032)
    args = parser.parse_args()
    PREFIX = "/" + args.prefix.strip("/")
    UPSTREAM = args.upstream
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", args.port), Handler) as httpd:
        print(
            "子路径反代已启动：http://127.0.0.1:%d%s/  ->  http://%s/"
            % (args.port, PREFIX, UPSTREAM),
            flush=True,
        )
        httpd.serve_forever()


if __name__ == "__main__":
    main()
