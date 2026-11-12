import os
import sys
from pathlib import Path

import pytest

# rag/ 를 import 경로에 넣는다(app, config, models 를 바로 import).
RAG_DIR = Path(__file__).resolve().parent.parent
if str(RAG_DIR) not in sys.path:
    sys.path.insert(0, str(RAG_DIR))

# 테스트는 OpenAI 를 절대 부르지 않는다.
os.environ["SPACELOG_FAKE_MODELS"] = "1"

TEST_TOKEN = "test-token-123"


@pytest.fixture
def make_config(tmp_path):
    """프로젝트 .env 를 읽지 않고 주어진 값만으로 설정을 만든다."""
    from config import load_config

    def _make(**extra):
        environ = {
            "SPACELOG_DATA": str(tmp_path / "data"),
            "SPACELOG_RAG_TOKEN": TEST_TOKEN,
            "SPACELOG_FAKE_MODELS": "1",
        }
        environ.update(extra)
        return load_config(environ=environ, env_file=None)

    return _make


@pytest.fixture
def client(make_config):
    from app import create_app

    app = create_app(make_config())
    app.testing = True
    return app.test_client()


@pytest.fixture
def auth():
    return {"X-Spacelog-Token": TEST_TOKEN}
