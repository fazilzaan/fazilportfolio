#!/usr/bin/env python3
"""Local portfolio server with password-protected admin and Cloudinary uploads."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
from email.parser import BytesParser
from email.policy import default as email_default
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PUBLIC_ROOT = ROOT / "public"
ENV_PATH = ROOT / ".env"
COOKIE_NAME = "fazil_admin_session"
SESSION_TTL_SECONDS = 60 * 60 * 12  # 12 hours
BLOCKED_FILES = {".env", ".env.example", "server.py", ".gitignore"}
MAX_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


ENV = load_env(ENV_PATH)
ADMIN_PASSWORD = ENV.get("ADMIN_PASSWORD", "")
SESSION_SECRET = ENV.get("SESSION_SECRET") or secrets.token_hex(32)
PORT = int(ENV.get("PORT", "3000"))
CLOUDINARY_CLOUD_NAME = ENV.get("CLOUDINARY_CLOUD_NAME", "").strip()
CLOUDINARY_API_KEY = ENV.get("CLOUDINARY_API_KEY", "").strip()
CLOUDINARY_API_SECRET = ENV.get("CLOUDINARY_API_SECRET", "").strip()
CLOUDINARY_FOLDER = ENV.get("CLOUDINARY_FOLDER", "fazil-portfolio").strip() or "fazil-portfolio"


def cloudinary_configured() -> bool:
    return bool(CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET)


def sign_session(issued_at: int) -> str:
    payload = f"admin:{issued_at}"
    signature = hmac.new(
        SESSION_SECRET.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{issued_at}.{signature}"


def is_valid_session(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    issued_raw, signature = token.split(".", 1)
    try:
        issued_at = int(issued_raw)
    except ValueError:
        return False
    if time.time() - issued_at > SESSION_TTL_SECONDS:
        return False
    expected = sign_session(issued_at)
    return hmac.compare_digest(f"{issued_at}.{signature}", expected)


def cloudinary_signature(params: dict[str, str]) -> str:
    to_sign = "&".join(f"{key}={params[key]}" for key in sorted(params))
    return hashlib.sha1((to_sign + CLOUDINARY_API_SECRET).encode("utf-8")).hexdigest()


def build_multipart(fields: dict[str, str], file_field: str, filename: str, content_type: str, file_bytes: bytes) -> tuple[bytes, str]:
    boundary = f"----fazil{uuid.uuid4().hex}"
    lines: list[bytes] = []

    for name, value in fields.items():
        lines.append(f"--{boundary}".encode())
        lines.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        lines.append(b"")
        lines.append(value.encode("utf-8"))

    safe_name = filename.replace('"', "")
    lines.append(f"--{boundary}".encode())
    lines.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{safe_name}"'.encode()
    )
    lines.append(f"Content-Type: {content_type or 'application/octet-stream'}".encode())
    lines.append(b"")
    lines.append(file_bytes)
    lines.append(f"--{boundary}--".encode())
    lines.append(b"")
    body = b"\r\n".join(lines)
    return body, f"multipart/form-data; boundary={boundary}"


def upload_to_cloudinary(file_bytes: bytes, filename: str, content_type: str) -> dict:
    if not cloudinary_configured():
        raise RuntimeError("Cloudinary is not configured in .env")

    timestamp = str(int(time.time()))
    sign_params = {
        "folder": CLOUDINARY_FOLDER,
        "timestamp": timestamp,
    }
    signature = cloudinary_signature(sign_params)

    fields = {
        "api_key": CLOUDINARY_API_KEY,
        "timestamp": timestamp,
        "folder": CLOUDINARY_FOLDER,
        "signature": signature,
    }

    body, content_type_header = build_multipart(
        fields,
        "file",
        filename or "upload.bin",
        content_type,
        file_bytes,
    )

    # Auto resource type works for video/image; prefer video endpoint for portfolio clips
    endpoint = f"https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD_NAME}/video/upload"
    request = Request(
        endpoint,
        data=body,
        headers={"Content-Type": content_type_header},
        method="POST",
    )

    try:
        with urlopen(request, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            message = parsed.get("error", {}).get("message") or detail
        except json.JSONDecodeError:
            message = detail or str(err)
        raise RuntimeError(message) from err
    except URLError as err:
        raise RuntimeError(f"Could not reach Cloudinary: {err.reason}") from err

    return payload


def parse_multipart(content_type: str, body: bytes) -> dict:
    """Parse multipart form into {name: {filename, content_type, data}} or string values."""
    if "boundary=" not in content_type:
        raise ValueError("Missing multipart boundary")

    message = BytesParser(policy=email_default).parsebytes(
        f"Content-Type: {content_type}\r\n\r\n".encode("utf-8") + body
    )
    result: dict = {}

    if not message.is_multipart():
        return result

    for part in message.iter_parts():
        disposition = part.get("Content-Disposition", "")
        if "name=" not in disposition:
            continue
        name_match = re.search(r'name="([^"]+)"', disposition)
        if not name_match:
            continue
        name = name_match.group(1)
        filename_match = re.search(r'filename="([^"]*)"', disposition)
        payload = part.get_payload(decode=True) or b""

        if filename_match is not None:
            result[name] = {
                "filename": filename_match.group(1) or "upload.bin",
                "content_type": part.get_content_type(),
                "data": payload,
            }
        else:
            result[name] = payload.decode("utf-8", errors="replace")

    return result


class PortfolioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if self._is_blocked(path):
            self.send_error(404, "Not Found")
            return

        if path == "/api/cloudinary/status":
            if not self._is_authenticated():
                self._json_response(401, {"ok": False, "error": "Unauthorized"})
                return
            self._json_response(
                200,
                {
                    "ok": True,
                    "configured": cloudinary_configured(),
                    "cloudName": CLOUDINARY_CLOUD_NAME if cloudinary_configured() else None,
                    "folder": CLOUDINARY_FOLDER if cloudinary_configured() else None,
                },
            )
            return

        if path in ("/admin", "/admin/", "/admin.html"):
            # Admin UI is gated by Firebase Auth in the browser (works on Hosting too).
            self.path = "/admin.html"
            return SimpleHTTPRequestHandler.do_GET(self)

        if path in ("/login", "/login.html"):
            self._redirect("/admin.html")
            return

        if path == "/api/logout":
            self._clear_session_and_redirect("/")
            return

        return SimpleHTTPRequestHandler.do_GET(self)

    def do_HEAD(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if self._is_blocked(path):
            self.send_error(404, "Not Found")
            return

        if path in ("/admin", "/admin/", "/admin.html"):
            self.path = "/admin.html"

        return SimpleHTTPRequestHandler.do_HEAD(self)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/login":
            self._handle_login()
            return

        if path == "/api/upload":
            self._handle_upload()
            return

        self.send_error(404, "Not Found")

    def _handle_login(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        password = ""

        content_type = self.headers.get("Content-Type", "")
        try:
            if "application/json" in content_type:
                data = json.loads(raw.decode("utf-8") or "{}")
                password = str(data.get("password", ""))
            else:
                form = parse_qs(raw.decode("utf-8"))
                password = (form.get("password") or [""])[0]
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json_response(400, {"ok": False, "error": "Invalid request"})
            return

        if not ADMIN_PASSWORD:
            self._json_response(
                500,
                {"ok": False, "error": "ADMIN_PASSWORD is not set in .env"},
            )
            return

        if not hmac.compare_digest(password, ADMIN_PASSWORD):
            time.sleep(0.4)
            self._json_response(401, {"ok": False, "error": "Invalid password"})
            return

        token = sign_session(int(time.time()))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header(
            "Set-Cookie",
            (
                f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; "
                f"Max-Age={SESSION_TTL_SECONDS}"
            ),
        )
        body = json.dumps({"ok": True}).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_upload(self):
        if not self._is_authenticated():
            self._json_response(401, {"ok": False, "error": "Unauthorized"})
            return

        if not cloudinary_configured():
            self._json_response(
                500,
                {
                    "ok": False,
                    "error": "Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to .env",
                },
            )
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            self._json_response(400, {"ok": False, "error": "Empty upload"})
            return
        if length > MAX_UPLOAD_BYTES:
            self._json_response(413, {"ok": False, "error": "File too large (max 200MB)"})
            return

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._json_response(400, {"ok": False, "error": "Expected multipart/form-data"})
            return

        raw = self.rfile.read(length)
        try:
            form = parse_multipart(content_type, raw)
        except Exception as err:
            self._json_response(400, {"ok": False, "error": f"Could not parse upload: {err}"})
            return

        file_item = form.get("file")
        if not isinstance(file_item, dict) or not file_item.get("data"):
            self._json_response(400, {"ok": False, "error": "No file provided"})
            return

        try:
            result = upload_to_cloudinary(
                file_item["data"],
                file_item.get("filename") or "upload.mp4",
                file_item.get("content_type") or "video/mp4",
            )
        except RuntimeError as err:
            self._json_response(502, {"ok": False, "error": str(err)})
            return
        except Exception as err:
            self._json_response(500, {"ok": False, "error": f"Upload failed: {err}"})
            return

        self._json_response(
            200,
            {
                "ok": True,
                "url": result.get("secure_url") or result.get("url"),
                "publicId": result.get("public_id"),
                "format": result.get("format"),
                "bytes": result.get("bytes"),
                "resourceType": result.get("resource_type"),
            },
        )

    def _is_blocked(self, path: str) -> bool:
        name = Path(path).name
        if name in BLOCKED_FILES or name.startswith(".env"):
            return True
        parts = Path(path.lstrip("/")).parts
        return any(part.startswith(".") for part in parts)

    def _is_authenticated(self) -> bool:
        cookie_header = self.headers.get("Cookie", "")
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(COOKIE_NAME)
        return is_valid_session(morsel.value if morsel else None)

    def _redirect(self, location: str, status: int = 302):
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _clear_session_and_redirect(self, location: str):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header(
            "Set-Cookie",
            f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _json_response(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")


def main():
    if not ADMIN_PASSWORD:
        print("Warning: ADMIN_PASSWORD is missing in .env — admin login will fail.")
    if not cloudinary_configured():
        print(
            "Warning: Cloudinary not configured. Add CLOUDINARY_CLOUD_NAME, "
            "CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to .env"
        )
    else:
        print(f"Cloudinary ready: cloud={CLOUDINARY_CLOUD_NAME}, folder={CLOUDINARY_FOLDER}")

    os.chdir(PUBLIC_ROOT)
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("127.0.0.1", PORT), PortfolioHandler)
    print(f"Portfolio running at http://127.0.0.1:{PORT}")
    print(f"Admin login at http://127.0.0.1:{PORT}/admin.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
