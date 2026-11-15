"""A small local HTTP server that behaves like the FIRMS country archive, for tests.

Serves files from a folder laid out as data/country/<dir>/<year>/<file>.csv.
Missing files -> 404 (like FIRMS). Paths listed in `flaky` fail with 503 a given number of times first.
"""
from __future__ import annotations

import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class _Handler(SimpleHTTPRequestHandler):
    flaky: dict = {}
    always_fail: set = set()
    html_instead: set = set()

    def log_message(self, *args):          # keep test output quiet
        pass

    def do_GET(self):
        name = self.path.rsplit("/", 1)[-1]
        if name in self.always_fail:
            self.send_error(500)
            return
        if self.flaky.get(name, 0) > 0:
            self.flaky[name] -= 1
            self.send_error(503)
            return
        if name in self.html_instead:
            body = b"<html><body>Service temporarily unavailable</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


class FakeFirms:
    def __init__(self, root: Path, flaky: dict | None = None, always_fail: set | None = None,
                 html_instead: set | None = None):
        handler = type("H", (_Handler,), {"flaky": dict(flaky or {}), "always_fail": set(always_fail or ()),
                                          "html_instead": set(html_instead or ())})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(handler, directory=str(root)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def country_base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/data/country"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
