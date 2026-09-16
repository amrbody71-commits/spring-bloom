"""Static server for development with caching switched off.

`python -m http.server` sends no cache headers, and Chrome then keeps ES
modules in its disk cache across reloads, so an edited module silently keeps
running its old code (the pane showed a page with none of the wired modules
while the files on disk were right). Every response here carries
`Cache-Control: no-store`, so a reload is a reload.

  python tools/serve.py 8326
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class NoStoreHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webp": "image/webp",
        ".woff2": "font/woff2",
        ".json": "application/json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8326
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(NoStoreHandler, directory=str(ROOT)))
    print(f"serving {ROOT} on http://127.0.0.1:{port}/ with no-store", flush=True)
    server.serve_forever()
