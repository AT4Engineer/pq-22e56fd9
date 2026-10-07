#!/usr/bin/env python3
"""Build dist/dashboard.html: ONE self-contained file (CSS, JS, favicon and the latest data inline).

It needs no network at all, so it works offline (e.g. downloaded from an email attachment and
opened in any browser). Optionally it can quietly try to load fresher data from a URL (for example
the GitHub Pages copy of data/portfolio.json) and falls back to the embedded snapshot if that fails.

Usage:
  python scripts/build_standalone.py                 # embed current data/portfolio.json
  python scripts/build_standalone.py --refresh       # run build_data.py first (fresh quotes)
  python scripts/build_standalone.py --remote-url https://<user>.github.io/<repo>/data/portfolio.json
  python scripts/build_standalone.py --out /some/path/dashboard.html
Env: DASHBOARD_REMOTE_URL (same as --remote-url; the flag wins). Empty = no network requests at all.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def safe_script(text):
    # keep inline <script> content from terminating the tag early
    return re.sub(r"</(script)", r"<\\/\1", text, flags=re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="run scripts/build_data.py first")
    ap.add_argument("--remote-url", default=os.environ.get("DASHBOARD_REMOTE_URL", ""))
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "dashboard.html"))
    a = ap.parse_args()

    if a.refresh:
        r = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "build_data.py")])
        if r.returncode != 0:
            print("[warn] build_data.py failed; embedding the last good data/portfolio.json", file=sys.stderr)

    data = json.loads(read("data/portfolio.json"))
    html = read("index.html")
    css = read("assets/style.css")
    js = read("assets/app.js")
    proj_js = read("assets/projection.js")
    icon = base64.b64encode(read("assets/favicon.svg").encode()).decode()

    data_json = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    cfg = json.dumps({"remoteUrl": a.remote_url.strip()})
    snap = data.get("generated_at_et", "")

    # PWA bits (manifest, icons, service worker) only make sense on the hosted site.
    html = re.sub(r"[ \t]*<!-- pwa:start.*?<!-- pwa:end -->\n?", "", html, flags=re.S)
    html = html.replace('<link rel="stylesheet" href="assets/style.css">', "<style>\n" + css + "\n</style>")
    html = html.replace('href="assets/favicon.svg" type="image/svg+xml"', f'href="data:image/svg+xml;base64,{icon}" type="image/svg+xml"')
    html = re.sub(r"<title>(.*?)</title>", lambda m: f"<title>{m.group(1)} - snapshot {snap}</title>", html, count=1)
    inline = (f'<script id="embedded-data" type="application/json">{data_json}</script>\n'
              f"  <script>window.DASHBOARD_CONFIG = {cfg};</script>\n"
              f"  <script>\n{safe_script(js)}\n</script>")
    html = html.replace('<script src="assets/projection.js"></script>', f"<script>\n{safe_script(proj_js)}\n</script>")
    html = html.replace('<script src="assets/app.js"></script>', inline)
    for leftover in ('href="assets/', 'src="assets/'):
        if leftover in html:
            sys.exit(f"build_standalone: unreplaced asset reference {leftover!r} in index.html")

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(html)
    os.replace(tmp, a.out)
    print(f"wrote {a.out} ({os.path.getsize(a.out) / 1024:.1f} KB) snapshot {snap}"
          + (f", remote {a.remote_url}" if a.remote_url else ", offline only"))


if __name__ == "__main__":
    main()
