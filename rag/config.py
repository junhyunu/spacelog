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
# 검색: 조각을 k 개 가져와 점수(코사인 유사도)가 min_score 미만이면 버린다.
# 진짜 임베딩(text-embedding-3-small)의 기본값은 0.25. 가짜 임베딩(DeterministicFakeEmbedding)은
# 글자가 다르면 점수가 무작위(64차원에서 최대 0.5 정도)라 테스트용 기본값을 0.6 으로 올린다.
# 둘 다 SPACELOG_RAG_K · SPACELOG_RAG_MIN_SCORE 로 바꿀 수 있다.
DEFAULT_SEARCH_K = 8
DEFAULT_MIN_SCORE = 0.25
DEFAULT_FAKE_MIN_SCORE = 0.6
# 긴 요약의 묶음(모델 호출) 수 상한. 넘으면 모델을 부르지 않고 too_broad. SPACELOG_RAG_SUM_MAX_BATCHES 로 바꾼다.
DEFAULT_SUM_MAX_BATCHES = 12


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
    search_k: int = DEFAULT_SEARCH_K
    min_score: float = DEFAULT_MIN_SCORE
    sum_max_batches: int = DEFAULT_SUM_MAX_BATCHES


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
    fake = _truthy(values.get("SPACELOG_FAKE_MODELS"))

    k_raw = str(values.get("SPACELOG_RAG_K") or "").strip()
    score_raw = str(values.get("SPACELOG_RAG_MIN_SCORE") or "").strip()
    try:
        search_k = int(k_raw) if k_raw else DEFAULT_SEARCH_K
        min_score = float(score_raw) if score_raw else (DEFAULT_FAKE_MIN_SCORE if fake else DEFAULT_MIN_SCORE)
    except ValueError as err:
        raise ConfigError("SPACELOG_RAG_K must be an integer and SPACELOG_RAG_MIN_SCORE a number") from err
    if search_k < 1 or not -1.0 <= min_score <= 1.0:
        raise ConfigError("SPACELOG_RAG_K must be >= 1 and SPACELOG_RAG_MIN_SCORE within [-1, 1]")

    batches_raw = str(values.get("SPACELOG_RAG_SUM_MAX_BATCHES") or "").strip()
    try:
        sum_max_batches = int(batches_raw) if batches_raw else DEFAULT_SUM_MAX_BATCHES
    except ValueError as err:
        raise ConfigError("SPACELOG_RAG_SUM_MAX_BATCHES must be an integer") from err
    if sum_max_batches < 1:
        raise ConfigError("SPACELOG_RAG_SUM_MAX_BATCHES must be >= 1")

    return Config(
        data_dir=data_dir.resolve(),
        port=port,
        model=str(values.get("OPENAI_MODEL") or "").strip() or DEFAULT_MODEL,
        embed_model=str(values.get("OPENAI_EMBED_MODEL") or "").strip() or DEFAULT_EMBED_MODEL,
        fake=fake,
        key_present=bool(api_key),
        token=token,
        api_key=api_key,
        search_k=search_k,
        min_score=min_score,
        sum_max_batches=sum_max_batches,
    )
