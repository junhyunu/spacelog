import json

import pytest

from conftest import TEST_TOKEN


def test_health_requires_token(client):
    r = client.get("/health")
    assert r.status_code == 401
    assert r.get_json() == {"error": "unauthorized"}

    r = client.get("/health", headers={"X-Spacelog-Token": "wrong"})
    assert r.status_code == 401
    assert r.get_json() == {"error": "unauthorized"}

    r = client.get("/health", headers={"X-Spacelog-Token": TEST_TOKEN})
    assert r.status_code == 200
    assert r.get_json()["ok"] is True


def test_unknown_route_also_requires_token(client):
    r = client.get("/nope")
    assert r.status_code == 401


def test_health_reports_key_presence_without_value(make_config, auth):
    from app import create_app

    secret = "sk-test-secret-value-xyz"
    app = create_app(make_config(OPENAI_API_KEY=secret, OPENAI_MODEL="m1", OPENAI_EMBED_MODEL="e1"))
    r = app.test_client().get("/health", headers=auth)
    body = r.get_json()
    assert body["key"] is True
    assert body["model"] == "m1"
    assert body["embed_model"] == "e1"
    assert secret not in r.get_data(as_text=True)


def test_health_key_false_when_missing(client, auth):
    body = client.get("/health", headers=auth).get_json()
    assert body["key"] is False
    assert body["embed_model"] == "text-embedding-3-small"


def test_fake_mode_flag(make_config, auth):
    from app import create_app

    body = create_app(make_config()).test_client().get("/health", headers=auth).get_json()
    assert body["fake"] is True

    body = create_app(make_config(SPACELOG_FAKE_MODELS="0")).test_client().get("/health", headers=auth).get_json()
    assert body["fake"] is False


def test_config_repr_hides_secrets(make_config):
    cfg = make_config(OPENAI_API_KEY="sk-hidden-abc")
    assert "sk-hidden-abc" not in repr(cfg)
    assert TEST_TOKEN not in repr(cfg)


def test_config_requires_token():
    from config import ConfigError, load_config

    with pytest.raises(ConfigError):
        load_config(environ={"SPACELOG_DATA": "x"}, env_file=None)


def test_config_port_default_and_override(make_config):
    assert make_config().port == 4748
    assert make_config(SPACELOG_RAG_PORT="4999").port == 4999


def test_env_file_is_read_but_environ_wins(tmp_path):
    from config import load_config

    env_file = tmp_path / ".env"
    env_file.write_text("OPENAI_API_KEY=sk-from-file\nOPENAI_MODEL=file-model\n", encoding="utf-8")
    cfg = load_config(environ={"SPACELOG_RAG_TOKEN": "t", "OPENAI_MODEL": "env-model"}, env_file=env_file)
    assert cfg.key_present is True
    assert cfg.model == "env-model"


def test_fake_models(make_config):
    from models import get_chat, get_embeddings

    cfg = make_config()
    emb = get_embeddings(cfg)
    assert len(emb.embed_query("안녕")) == 64

    chat = get_chat(cfg, responses=["첫 답", "둘째 답"])
    assert chat.invoke("q").content == "첫 답"
    assert chat.invoke("q").content == "둘째 답"

    # 기본 가짜 모델도 부를 수 있다
    assert isinstance(get_chat(cfg).invoke("q").content, str)
