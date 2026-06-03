#!/usr/bin/env python3
"""Bundle Recorder Replay — local desktop launcher.

Runs replay.html as if it were a desktop app:
  - Starts a tiny HTTP server on 127.0.0.1
  - Opens Chrome (or Edge) with a FRESH profile and extensions DISABLED
    so ad-blockers / privacy tools can't interfere with the rrweb iframe
  - Closes the server cleanly when you Ctrl+C the console

Why a desktop app?
  - No GitHub Pages cache to invalidate
  - No browser extensions messing with iframes / scripts
  - Full DevTools access (Network tab, Sources, Console)
  - One double-click instead of a bookmarked URL

Run it from the repo root:
    python replay-app.py
or double-click replay-app.bat (Windows).

Tested on Python 3.8+ (stdlib only, no install).
"""

from __future__ import annotations

import http.server
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import webbrowser
from pathlib import Path

# -----------------------------------------------------------------
#  Configuration
# -----------------------------------------------------------------
PREFERRED_PORT = 8765         # we'll fall through to PORT+99 if taken
ENTRY = 'replay.html'         # what to open
SERVE_ROOT = Path(__file__).resolve().parent

# Best-effort list of Chromium-family browser paths on Windows.
# We try them in order; first hit wins. macOS / Linux paths also covered.
BROWSER_CANDIDATES = [
    # Windows
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    # User-local installs
    os.path.expanduser(r'~\AppData\Local\Google\Chrome\Application\chrome.exe'),
    # macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    # Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
]


# -----------------------------------------------------------------
#  HTTP server
# -----------------------------------------------------------------
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Like SimpleHTTPRequestHandler but rooted at SERVE_ROOT and quieter."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_ROOT), **kwargs)

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib hook name
        # Print only requests for our entry / interesting files
        msg = fmt % args
        if any(k in msg for k in ('replay.html', '.js', '.css', '/jack-photos/')):
            print(f'  {msg}', flush=True)

    def end_headers(self):
        # Disable caching so iteration during debugging is instant
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


def find_free_port(start: int, tries: int = 100) -> int:
    """Return the first free port >= start (within `tries` attempts)."""
    for offset in range(tries):
        port = start + offset
        # Quick probe: try to bind, immediately close
        try:
            with socketserver.TCPServer(('127.0.0.1', port), QuietHandler) as probe:
                pass
            return port
        except OSError:
            continue
    raise RuntimeError(f'No free port in range {start}..{start + tries - 1}')


# -----------------------------------------------------------------
#  Browser launcher
# -----------------------------------------------------------------
def launch_browser(url: str) -> None:
    """Open `url` in Chrome/Edge with a fresh profile + extensions off.

    Falls back to the OS default browser if no Chromium binary is found.
    """
    chromium = next((p for p in BROWSER_CANDIDATES if os.path.exists(p)), None)

    if chromium is None:
        print('  [!] No Chrome/Edge found, opening in default browser '
              '(extensions WILL be active).', flush=True)
        webbrowser.open(url)
        return

    profile_dir = Path(tempfile.gettempdir()) / 'bundle-replay-profile'
    profile_dir.mkdir(exist_ok=True)

    args = [
        chromium,
        f'--user-data-dir={profile_dir}',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-features=TranslateUI',
        # Open in an "app window" — no tabs, no address bar
        f'--app={url}',
    ]

    print(f'  Launching: {os.path.basename(chromium)} '
          f'(--app mode, no extensions, fresh profile at {profile_dir})',
          flush=True)
    try:
        subprocess.Popen(args, close_fds=True)
    except Exception as e:
        print(f'  [!] Failed to launch Chrome ({e}); falling back to default '
              f'browser.', flush=True)
        webbrowser.open(url)


# -----------------------------------------------------------------
#  Main
# -----------------------------------------------------------------
def main() -> int:
    if not (SERVE_ROOT / ENTRY).exists():
        print(f'[x] {ENTRY} not found in {SERVE_ROOT}', file=sys.stderr)
        print('    Run this script from the repo root that contains '
              f'{ENTRY}.', file=sys.stderr)
        return 1

    port = find_free_port(PREFERRED_PORT)
    url = f'http://127.0.0.1:{port}/{ENTRY}'

    print('━' * 64)
    print('  Bundle Recorder Replay — Desktop')
    print('━' * 64)
    print(f'  Serving: {SERVE_ROOT}')
    print(f'  URL:     {url}')
    print('  Press Ctrl+C to stop the server and close the app.')
    print('━' * 64)
    print()

    # Open the browser in a background thread once the server is bound
    threading.Timer(0.4, lambda: launch_browser(url)).start()

    # Bind for real and serve
    handler = QuietHandler
    with socketserver.ThreadingTCPServer(('127.0.0.1', port), handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n  Shutting down…')
            httpd.shutdown()

    return 0


if __name__ == '__main__':
    sys.exit(main())
