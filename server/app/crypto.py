"""字段加密工具：buyer 字段入库加密、出库解密、哈希查找。

算法选型：
- 对称加密：AES-256-GCM（带完整性校验的流式加密）
- 查找哈希：SHA-256（不可逆，用于唯一约束 + 密文匹配查找）

密钥来源：BX_CRYPTO_KEY 环境变量（32 字节十六进制）。未配置时自动生成并持久化到 data/.crypto_key 文件，
确保同一台机器重启后能解密已入库数据。生产部署建议通过环境变量显式注入。

加密存储格式：base64(IV + GCM_tag + ciphertext)，单次加密随机 IV，相同明文每次密文不同。
"""
from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
from typing import Optional

from Crypto.Cipher import AES

from . import config

_KEY_FILE = Path(config.DATA_DIR) / ".crypto_key"


def _load_or_create_key() -> bytes:
    """加载或生成 32 字节 AES 密钥。"""
    env_key = os.getenv("BX_CRYPTO_KEY", "").strip()
    if env_key:
        # 支持 hex（64 字符）或原始 base64
        try:
            raw = bytes.fromhex(env_key)
            if len(raw) == 32:
                return raw
        except ValueError:
            pass
        try:
            raw = base64.b64decode(env_key)
            if len(raw) == 32:
                return raw
        except Exception:
            pass
        raise RuntimeError("BX_CRYPTO_KEY 必须是 32 字节的 hex(64字符) 或 base64(44字符)")

    # 本地自动生成 + 持久化
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if _KEY_FILE.exists():
        raw = _KEY_FILE.read_bytes()
        if len(raw) == 32:
            return raw
    raw = os.urandom(32)
    _KEY_FILE.write_bytes(raw)
    try:
        _KEY_FILE.chmod(0o600)
    except Exception:
        pass
    return raw


_AES_KEY = _load_or_create_key()


def encrypt(plaintext: str) -> str:
    """AES-256-GCM 加密。相同明文每次密文不同（随机 IV）。返回 base64 字符串。"""
    if plaintext is None:
        return ""
    data = plaintext.encode("utf-8")
    iv = os.urandom(12)
    cipher = AES.new(_AES_KEY, AES.MODE_GCM, nonce=iv)
    ciphertext, tag = cipher.encrypt_and_digest(data)
    # IV(12) + tag(16) + ciphertext
    raw = iv + tag + ciphertext
    return base64.b64encode(raw).decode("ascii")


def decrypt(ciphertext: str) -> str:
    """解密。格式错误或密钥不匹配返回空字符串（不抛异常，避免前端 500）。"""
    if not ciphertext:
        return ""
    try:
        raw = base64.b64decode(ciphertext)
        iv, tag, data = raw[:12], raw[12:28], raw[28:]
        cipher = AES.new(_AES_KEY, AES.MODE_GCM, nonce=iv)
        plain = cipher.decrypt_and_verify(data, tag)
        return plain.decode("utf-8")
    except Exception:
        return ""


def sha256_hex(plaintext: str) -> str:
    """SHA-256 哈希（hex），用于唯一约束 + 密文匹配查找。不可逆。"""
    if not plaintext:
        return ""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
