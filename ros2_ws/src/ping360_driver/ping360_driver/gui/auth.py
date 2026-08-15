from __future__ import annotations

import base64
import hmac
import os
import secrets
import time
from dataclasses import dataclass
from typing import Optional

import paramiko


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


@dataclass(frozen=True)
class Session:
    username: str
    jetson_host: str
    jetson_user: str
    rosbridge_ws_url: str
    issued_at: int


class SessionSigner:
    def __init__(self, secret: bytes, ttl_seconds: int = 12 * 60 * 60) -> None:
        self._secret = secret
        self._ttl = ttl_seconds

    def mint(self, *, username: str, jetson_host: str, jetson_user: str, rosbridge_ws_url: str) -> str:
        issued_at = int(time.time())
        # Avoid JSON to keep token tiny and robust.
        payload = f"{username}\n{jetson_host}\n{jetson_user}\n{rosbridge_ws_url}\n{issued_at}".encode("utf-8")
        sig = hmac.new(self._secret, payload, digestmod="sha256").digest()
        return f"{_b64url(payload)}.{_b64url(sig)}"

    def verify(self, token: str) -> Optional[Session]:
        try:
            p, s = token.split(".", 1)
            payload = _b64url_decode(p)
            sig = _b64url_decode(s)
        except Exception:
            return None

        expected = hmac.new(self._secret, payload, digestmod="sha256").digest()
        if not hmac.compare_digest(expected, sig):
            return None

        try:
            username, jetson_host, jetson_user, rosbridge_ws_url, issued_at_s = payload.decode("utf-8").split("\n", 4)
            issued_at = int(issued_at_s)
        except Exception:
            return None

        if int(time.time()) - issued_at > self._ttl:
            return None

        return Session(
            username=username,
            jetson_host=jetson_host,
            jetson_user=jetson_user,
            rosbridge_ws_url=rosbridge_ws_url,
            issued_at=issued_at,
        )


def load_or_create_secret(path: str) -> bytes:
    if os.path.exists(path):
        with open(path, "rb") as f:
            data = f.read().strip()
        if len(data) >= 32:
            return data

    os.makedirs(os.path.dirname(path), exist_ok=True)
    secret = secrets.token_bytes(32)
    with open(path, "wb") as f:
        f.write(secret)
    return secret


def pam_authenticate(username: str, password: str) -> bool:
    """
    Authenticate against local system accounts (PAM).

    Uses `python3 -c` subprocess to avoid extra deps; relies on `pam_unix` via
    libc PAM stack present on Ubuntu.
    """
    import subprocess
    import sys

    # Inline python uses ctypes to call PAM.
    # This avoids needing `python-pam` package.
    code = r"""
import ctypes, ctypes.util, os, sys

libpam_path = ctypes.util.find_library("pam")
if not libpam_path:
    sys.exit(2)
libpam = ctypes.CDLL(libpam_path)

PAM_SUCCESS = 0

class pam_message(ctypes.Structure):
    _fields_ = [("msg_style", ctypes.c_int),
                ("msg", ctypes.c_char_p)]

class pam_response(ctypes.Structure):
    _fields_ = [("resp", ctypes.c_char_p),
                ("resp_retcode", ctypes.c_int)]

conv_func = ctypes.CFUNCTYPE(ctypes.c_int,
                             ctypes.c_int,
                             ctypes.POINTER(ctypes.POINTER(pam_message)),
                             ctypes.POINTER(ctypes.POINTER(pam_response)),
                             ctypes.c_void_p)

PAM_PROMPT_ECHO_OFF = 1
PAM_PROMPT_ECHO_ON = 2
PAM_ERROR_MSG = 3
PAM_TEXT_INFO = 4

def make_conv(password: bytes):
    def conv(n_messages, messages, p_response, appdata_ptr):
        arr = ctypes.cast(messages, ctypes.POINTER(ctypes.POINTER(pam_message)))
        res_arr = (pam_response * n_messages)()
        for i in range(n_messages):
            msg = arr[i].contents
            if msg.msg_style in (PAM_PROMPT_ECHO_OFF, PAM_PROMPT_ECHO_ON):
                res_arr[i].resp = ctypes.create_string_buffer(password).value
                res_arr[i].resp_retcode = 0
            else:
                res_arr[i].resp = None
                res_arr[i].resp_retcode = 0
        p_response[0] = ctypes.cast(res_arr, ctypes.POINTER(pam_response))
        return PAM_SUCCESS
    return conv_func(conv)

username = sys.argv[1].encode()
password = sys.argv[2].encode()
service = b"login"

pamh = ctypes.c_void_p()
conv = ctypes.Structure

class pam_conv(ctypes.Structure):
    _fields_ = [("conv", conv_func),
                ("appdata_ptr", ctypes.c_void_p)]

pc = pam_conv(make_conv(password), None)

libpam.pam_start.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(pam_conv), ctypes.POINTER(ctypes.c_void_p)]
libpam.pam_start.restype = ctypes.c_int
libpam.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
libpam.pam_authenticate.restype = ctypes.c_int
libpam.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
libpam.pam_acct_mgmt.restype = ctypes.c_int
libpam.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]
libpam.pam_end.restype = ctypes.c_int

r = libpam.pam_start(service, username, ctypes.byref(pc), ctypes.byref(pamh))
if r != PAM_SUCCESS:
    sys.exit(3)
r = libpam.pam_authenticate(pamh, 0)
if r != PAM_SUCCESS:
    libpam.pam_end(pamh, r)
    sys.exit(1)
r2 = libpam.pam_acct_mgmt(pamh, 0)
libpam.pam_end(pamh, r2)
if r2 != PAM_SUCCESS:
    sys.exit(1)
sys.exit(0)
"""
    try:
        p = subprocess.run(
            [sys.executable, "-c", code, username, password],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        return p.returncode == 0
    except Exception:
        return False


def ssh_authenticate(host: str, user: str, password: str, timeout_s: float = 5.0) -> bool:
    """
    Check Jetson credentials by attempting an SSH login.
    """
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            username=user,
            password=password,
            look_for_keys=False,
            allow_agent=False,
            banner_timeout=timeout_s,
            auth_timeout=timeout_s,
            timeout=timeout_s,
        )
        return True
    except Exception:
        return False
    finally:
        try:
            client.close()
        except Exception:
            pass


def ssh_exec(host: str, user: str, password: str, command: str, timeout_s: float = 10.0) -> str:
    """
    Execute a command via SSH and return stdout (stderr merged).
    """
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            username=user,
            password=password,
            look_for_keys=False,
            allow_agent=False,
            banner_timeout=timeout_s,
            auth_timeout=timeout_s,
            timeout=timeout_s,
        )
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout_s, get_pty=False)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return (out + err).strip()
    finally:
        try:
            client.close()
        except Exception:
            pass

