"""설정: 환경 변수와 프로젝트 루트의 .env 를 읽는다.

키 · 토큰 값은 repr 에 나오지 않게 하고, 응답이나 로그에 절대 넣지 않는다.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"

DEFAULT_PORT = 4748
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_EMBED_MODEL = "text-embedding-3-small"


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    data_dir: Path
    port: int
    model: str
    embed_model: str
    fake: bool
    key_present: bool
    token: str = field(repr=False)
    api_key: str = field(repr=False, default="")


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def load_config(environ=None, env_file=ENV_FILE) -> Config:
    """environ(기본 os.environ)이 .env 파일보다 우선한다. env_file=None 이면 파일을 읽지 않는다(테스트)."""
    values = {}
    if env_file is not None and Path(env_file).is_file():
        values.update({k: v for k, v in dotenv_values(env_file).items() if v is not None})
    values.update(os.environ if environ is None else environ)

    token = str(values.get("SPACELOG_RAG_TOKEN") or "").strip()
    if not token:
        raise ConfigError("SPACELOG_RAG_TOKEN is required")

    port_raw = str(values.get("SPACELOG_RAG_PORT") or "").strip()
    try:
        port = int(port_raw) if port_raw else DEFAULT_PORT
    except ValueError as err:
        raise ConfigError("SPACELOG_RAG_PORT must be an integer") from err

    data_raw = str(values.get("SPACELOG_DATA") or "").strip()
    data_dir = Path(data_raw) if data_raw else Path.home() / "spaceLog"

    api_key = str(values.get("OPENAI_API_KEY") or "").strip()
    return Config(
        data_dir=data_dir.resolve(),
        port=port,
        model=str(values.get("OPENAI_MODEL") or "").strip() or DEFAULT_MODEL,
        embed_model=str(values.get("OPENAI_EMBED_MODEL") or "").strip() or DEFAULT_EMBED_MODEL,
        fake=_truthy(values.get("SPACELOG_FAKE_MODELS")),
        key_present=bool(api_key),
        token=token,
        api_key=api_key,
    )
