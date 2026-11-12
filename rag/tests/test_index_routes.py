"""색인 Flask 경로: POST /index · /remove · /reset · /flush, GET /stats."""

import pytest
from langchain_core.embeddings import DeterministicFakeEmbedding

from conftest import TEST_TOKEN


@pytest.fixture
def app(make_config):
    from app import create_app

    app = create_app(make_config(), embeddings=DeterministicFakeEmbedding(size=64))
    app.testing = True
    yield app
    from app import run_shutdown_hooks

    run_shutdown_hooks(app)


@pytest.fixture
def c(app):
    return app.test_client()


def star(sid="s1", **extra):
    base = {
        "id": sid,
        "planet_id": "p1",
        "planet_name": "화성",
        "title": "제목",
        "body": "본문",
        "memo": "메모",
        "created_at": "2026-05-01T00:00:00.000Z",
        "attachments": [],
    }
    base.update(extra)
    return base


def test_routes_require_token(c):
    for method, route in [("post", "/index"), ("post", "/remove"), ("post", "/reset"),
                          ("get", "/stats"), ("post", "/flush")]:
        r = getattr(c, method)(route, json={})
        assert r.status_code == 401, route


def test_index_remove_stats_flow(c, auth, tmp_path):
    folder = tmp_path / "data" / "vault"  # SPACELOG_DATA 의 보관함(밖은 읽지 않는다)
    folder.mkdir(parents=True)
    f = folder / "관측 기록.txt"
    f.write_text("목성 대적점 관측", encoding="utf-8")
    payload = star(attachments=[
        {"id": "a1", "kind": "file", "file_name": "관측 기록.txt", "file_ext": "TXT",
         "url": None, "link_title": None, "path": str(f)},
        {"id": "a2", "kind": "file", "file_name": "문서.hwp", "file_ext": "HWP",
         "url": None, "link_title": None, "path": str(folder / "문서.hwp")},
    ])
    r = c.post("/index", json=payload, headers=auth)
    assert r.status_code == 200
    assert r.get_json() == {"chunks": 5, "notes": [{"attachment_id": "a2", "note": "unsupported"}]}

    c.post("/index", json=star("s2"), headers=auth)
    assert c.get("/stats", headers=auth).get_json() == {"chunks": 8, "stars": 2}

    r = c.post("/remove", json={"star_ids": ["s1"]}, headers=auth)
    assert r.get_json() == {"removed": 5}
    assert c.get("/stats", headers=auth).get_json() == {"chunks": 3, "stars": 1}

    assert c.post("/reset", json={}, headers=auth).get_json() == {"ok": True}
    assert c.get("/stats", headers=auth).get_json() == {"chunks": 0, "stars": 0}


def test_flush_writes_index_file(c, auth, make_config):
    c.post("/index", json=star(), headers=auth)
    assert c.post("/flush", headers=auth).get_json() == {"ok": True, "saved": True}
    assert c.post("/flush", headers=auth).get_json() == {"ok": True, "saved": False}
    assert (make_config().data_dir / "rag" / "index.json").is_file()


def test_shutdown_hook_flushes(make_config, auth):
    from app import create_app, run_shutdown_hooks

    emb = DeterministicFakeEmbedding(size=64)
    a = create_app(make_config(), embeddings=emb)
    a.test_client().post("/index", json=star(), headers=auth)
    run_shutdown_hooks(a)
    assert (make_config().data_dir / "rag" / "index.json").is_file()

    b = create_app(make_config(), embeddings=emb)
    assert b.test_client().get("/stats", headers=auth).get_json() == {"chunks": 3, "stars": 1}
    run_shutdown_hooks(b)


@pytest.mark.parametrize("payload", [None, [], {"title": "id 없음"}, {"id": 3}, {"id": "a:b"},
                                     {"id": "s", "attachments": "x"}])
def test_index_bad_request(c, auth, payload):
    r = c.post("/index", json=payload, headers=auth)
    assert r.status_code == 400
    assert r.get_json() == {"error": "bad_request"}


@pytest.mark.parametrize("payload", [None, {}, {"star_ids": "s1"}, {"star_ids": [1]}])
def test_remove_bad_request(c, auth, payload):
    r = c.post("/remove", json=payload, headers=auth)
    assert r.status_code == 400
    assert r.get_json() == {"error": "bad_request"}


def test_broken_attachment_does_not_fail_index(c, auth, tmp_path):
    p = tmp_path / "깨진 문서.docx"
    p.write_bytes(b"PK\x03\x04garbage")
    r = c.post("/index", json=star(attachments=[
        {"id": "a1", "kind": "file", "file_name": "깨진 문서.docx", "file_ext": "DOCX", "path": str(p)},
    ]), headers=auth)
    assert r.status_code == 200
    body = r.get_json()
    assert body["chunks"] == 4
    assert body["notes"][0]["attachment_id"] == "a1"
    assert body["notes"][0]["note"].startswith("error:")


def test_key_missing_without_fake(make_config, auth):
    from app import create_app, run_shutdown_hooks

    a = create_app(make_config(SPACELOG_FAKE_MODELS="0"))
    c = a.test_client()
    r = c.post("/index", json=star(), headers=auth)
    assert r.status_code == 503
    assert r.get_json() == {"error": "key_missing"}
    # 키가 없어도 지우기 · 통계는 된다
    assert c.post("/remove", json={"star_ids": ["s1"]}, headers=auth).get_json() == {"removed": 0}
    assert c.get("/stats", headers=auth).get_json() == {"chunks": 0, "stars": 0}
    run_shutdown_hooks(a)


def test_embedding_failure_is_502_without_details(make_config, auth, capsys):
    from app import create_app, run_shutdown_hooks

    class Boom(DeterministicFakeEmbedding):
        def embed_documents(self, texts):
            raise RuntimeError("secret body text sk-abc")

    a = create_app(make_config(), embeddings=Boom(size=64))
    r = a.test_client().post("/index", json=star(), headers=auth)
    assert r.status_code == 502
    assert r.get_json() == {"error": "embed_failed"}
    err = capsys.readouterr().err
    assert "secret" not in err and "sk-abc" not in err
    run_shutdown_hooks(a)


def test_too_large_body(c, auth):
    r = c.post("/index", data=b"x" * (8 * 1024 * 1024 + 1), headers={**auth, "content-type": "application/json"})
    assert r.status_code == 413
    assert r.get_json() == {"error": "too_large"}


def test_token_constant_matches():
    assert TEST_TOKEN
