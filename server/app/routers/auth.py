"""认证路由：登录 / 登出 / 当前用户。"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from .. import db, security

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    account: str
    password: str


@router.post("/login")
def login(body: LoginBody) -> Dict[str, Any]:
    row = db.query_one(
        """
        SELECT u.*, g.name AS group_name
        FROM users u LEFT JOIN groups g ON g.id = u.group_id
        WHERE u.account = ?
        """,
        (body.account.strip(),),
    )
    if not row or not security.verify_password(body.password, row["salt"], row["password_hash"]):
        raise HTTPException(status_code=401, detail="账号或密码错误")
    token = security.create_session(row["id"])
    security.audit(row, "登录", row["account"])
    return {"token": token, "user": security.user_payload(row)}


@router.post("/logout")
def logout(
    authorization: Optional[str] = Header(default=None),
    user: Dict[str, Any] = Depends(security.get_current_user),
) -> Dict[str, Any]:
    token = security._parse_bearer(authorization)
    if token:
        security.delete_session(token)
    return {"ok": True}


@router.get("/me")
def me(user: Dict[str, Any] = Depends(security.get_current_user)) -> Dict[str, Any]:
    return user
