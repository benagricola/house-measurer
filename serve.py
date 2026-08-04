#!/usr/bin/env python3
"""Dev server: python http.server + no-cache headers.

Plain `python3 -m http.server` lets browsers cache ES modules on heuristic
freshness, so edits appear to "not take" until a hard reload. This variant
tells the browser to revalidate every file, so a normal reload always gets
the current code. Usage: ./serve.py [port]  (default 8017)
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8017
    http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
