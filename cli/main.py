#!/usr/bin/env python3
"""Local CLI wrapper and temporary HTTP bridge for CP Editor Codeforces submissions."""

import argparse
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 4242

MAJOR_VERSION = 1
MINOR_VERSION = 0
PATCH_VERSION = 0
VERSION = f"{MAJOR_VERSION}.{MINOR_VERSION}.{PATCH_VERSION}"

LANG_MAP = {
    ".cpp": "89",  # GNU G++20 64-bit
    ".c": "43",  # GNU GCC C11
    ".py": "31",  # Python 3
    ".java": "87",  # Java 21 64-bit
    ".rs": "75",  # Rust
}

job_payload = {}
job_claimed = False
submission_done = threading.Event()
final_exit_code = 0


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP request handler serving job payloads and receiving extension status updates."""

    def log_message(self, format, *args):
        """Suppress default stderr HTTP access logs."""

    def _send_json(self, data, status=200):
        """Send JSON response with CORS and Private Network Access headers."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def do_OPTIONS(self):
        """Handle browser CORS preflight requests."""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        """Serve the pending submission job once to the first polling extension worker."""
        global job_claimed
        if self.path == "/job":
            if not job_claimed:
                job_claimed = True
                self._send_json({"has_job": True, "job": job_payload})
            else:
                self._send_json({"has_job": False})
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        """Receive progress messages and completion signals from the browser extension."""
        global final_exit_code
        if self.path == "/status":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))

            message = body.get("message", "")
            if message:
                print(message, flush=True)

            if body.get("done"):
                final_exit_code = 0 if body.get("success") else 1
                submission_done.set()

            self._send_json({"ok": True})
        else:
            self._send_json({"error": "Not found"}, 404)


def parse_target(target_args):
    """Extract (contest_id, problem_index, is_gym) from a problem URL or CLI arguments."""
    if len(target_args) == 1:
        url = target_args[0]
        m = re.search(
            r"/(?:contest|gym)/(\d+)/problem/([A-Za-z0-9]+)", url
        ) or re.search(r"/problemset/problem/(\d+)/([A-Za-z0-9]+)", url)
        if m:
            return m.group(1), m.group(2).upper(), ("/gym/" in url)
    elif len(target_args) >= 2:
        cid = target_args[0]
        idx = target_args[1].upper()
        return cid, idx, (int(cid) >= 100000)
    return None, None, False


def handle_submit(args):
    """Validate source file, host temporary bridge server, and wait for extension completion."""
    file_path = Path(args.file)
    if not file_path.exists():
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    ext = file_path.suffix.lower()
    lang_id = LANG_MAP.get(ext)
    if not lang_id:
        print(f"Error: Unsupported extension '{ext}'", file=sys.stderr)
        sys.exit(1)

    contest_id, problem_index, is_gym = parse_target(args.target)
    if not contest_id:
        print(f"Error: Could not parse target: {args.target}", file=sys.stderr)
        sys.exit(1)

    global job_payload
    job_payload = {
        "contestId": str(contest_id),
        "problemIndex": problem_index,
        "programTypeId": lang_id,
        "ext": ext,
        "source": file_path.read_text(encoding="utf-8"),
        "isGym": is_gym,
    }

    server = HTTPServer((HOST, PORT), BridgeHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    print(
        f"Waiting for browser extension to submit {contest_id}{problem_index}...",
        flush=True,
    )

    completed = submission_done.wait(timeout=180)
    server.shutdown()

    if not completed:
        print("Error: Timed out waiting for browser extension.", file=sys.stderr)
        sys.exit(1)

    sys.exit(final_exit_code)


def main():
    """Parse CLI subcommands and emulate cf-tool v1.0.0 interface for CP Editor."""
    if "--version" in sys.argv or "-v" in sys.argv:
        print(f"cf-tool (cf) v{VERSION}")
        sys.exit(0)

    parser = argparse.ArgumentParser(prog="cf")
    subparsers = parser.add_subparsers(dest="command")

    submit_parser = subparsers.add_parser("submit")
    submit_parser.add_argument("-f", "--file", required=True)
    submit_parser.add_argument("target", nargs="+")

    subparsers.add_parser("config")

    args = parser.parse_args()
    if args.command == "submit":
        handle_submit(args)
    elif args.command == "config":
        print("Configured via active browser session bridge.")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
