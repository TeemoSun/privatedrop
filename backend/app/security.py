import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import settings

APP_PASSWORD_HASH: str | None = None

_login_attempts: dict[str, deque[datetime]] = defaultdict(deque)
LOGIN_WINDOW = timedelta(seconds=60)
LOGIN_MAX_ATTEMPTS = 5
_MAX_IPS = 10_000

_revoked_jtis: dict[str, datetime] = {}


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("ascii"))
    except ValueError:
        return False


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def check_login_rate(ip: str) -> bool:
    now = utc_now()
    queue = _login_attempts[ip]
    while queue and now - queue[0] > LOGIN_WINDOW:
        queue.popleft()
    if len(queue) >= LOGIN_MAX_ATTEMPTS:
        return False
    if len(_login_attempts) >= _MAX_IPS and ip not in _login_attempts:
        for key in list(_login_attempts.keys()):
            queue_k = _login_attempts[key]
            if not queue_k or (now - queue_k[-1] > LOGIN_WINDOW):
                del _login_attempts[key]
            if len(_login_attempts) < _MAX_IPS:
                break
    queue.append(now)
    return True


def create_access_token(device_id: uuid.UUID) -> str:
    now = utc_now()
    jti = uuid.uuid4()
    return jwt.encode(
        {
            "sub": str(device_id),
            "type": "access",
            "jti": str(jti),
            "iat": now,
            "exp": now + timedelta(minutes=settings.access_token_minutes),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )


def create_refresh_token(device_id: uuid.UUID, jti: uuid.UUID) -> str:
    now = utc_now()
    return jwt.encode(
        {
            "sub": str(device_id),
            "type": "refresh",
            "jti": str(jti),
            "iat": now,
            "exp": now + timedelta(days=settings.refresh_token_days),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )


def _decode_access_payload(token: str) -> dict:
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    if payload.get("type") != "access":
        raise jwt.InvalidTokenError("not an access token")
    if payload.get("jti") in _revoked_jtis:
        raise jwt.InvalidTokenError("access token revoked")
    return payload


def decode_access_token(token: str) -> uuid.UUID:
    return uuid.UUID(_decode_access_payload(token)["sub"])


def decode_access_token_jti(token: str) -> str:
    return str(_decode_access_payload(token)["jti"])


def decode_refresh_token(token: str) -> tuple[uuid.UUID, uuid.UUID]:
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    if payload.get("type") != "refresh":
        raise jwt.InvalidTokenError("not a refresh token")
    return uuid.UUID(payload["sub"]), uuid.UUID(payload["jti"])


def revoke_access_tokens(*jtis: str) -> None:
    now = utc_now()
    for jti in jtis:
        _revoked_jtis[jti] = now


def cleanup_revoked_jtis(max_age_seconds: int = 900) -> int:
    now = utc_now()
    cutoff = timedelta(seconds=max_age_seconds)
    expired = [jti for jti, revoked_at in _revoked_jtis.items() if now - revoked_at > cutoff]
    for jti in expired:
        _revoked_jtis.pop(jti, None)
    return len(expired)
