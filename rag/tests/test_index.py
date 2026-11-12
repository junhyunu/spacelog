"""StarIndex: 별을 조각으로 넣고 · 지우고 · 찾고 · 모아 저장하기(가짜 임베딩)."""

import json
import threading

import pytest
from langchain_core.embeddings import DeterministicFakeEmbedding

from index import StarIndex


@pytest.fixture
def emb():
    return DeterministicFakeEmbedding(size=64)


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "데이터 폴더"


@pytest.fixture
def idx(data_dir, emb):
    index = StarIndex(data_dir, emb)
    yield index
    index.close()


def star(sid="s1", planet="p1", created="2026-03-01T09:00:00.000Z", **extra):
    base = {
        "id": sid,
        "planet_id": planet,
        "planet_name": "목성",
        "title": f"{sid} 제목",
        "body": f"{sid} 본문 글이에요.",
        "memo": f"{sid} 메모",
        "created_at": created,
        "attachments": [],
    }
    base.update(extra)
    return base


def test_index_folder_is_created(idx, data_dir):
    assert (data_dir / "rag").is_dir()


def test_upsert_twice_replaces_chunks(idx):
    first = idx.upsert(star())
    assert first["chunks"] == 3
    assert first["notes"] == []
    second = idx.upsert(star())
    assert second["chunks"] == 3
    assert idx.stats() == {"chunks": 3, "stars": 1}


def test_upsert_with_fewer_chunks_drops_old_ones(idx):
    idx.upsert(star())
    idx.upsert(star(memo="", body=""))
    assert idx.stats() == {"chunks": 1, "stars": 1}
    assert [d.id for d in idx.chunks_for(["s1"])] == ["s1:0"]


def test_long_body_is_split(idx):
    body = "\n\n".join(f"문단 {i} " + "가나다라 " * 60 for i in range(10))
    out = idx.upsert(star(body=body, memo="", title=""))
    assert out["chunks"] > 3
    for doc in idx.chunks_for(["s1"]):
        assert len(doc.page_content) <= 800 + 100  # 행성 줄 · 파일 이름 머리 여유


def test_metadata_fields_and_ids(idx, tmp_path):
    f = tmp_path / "첨부 폴더" / "관측 노트.txt"
    f.parent.mkdir()
    f.write_text("토성 고리 관측 기록", encoding="utf-8")
    out = idx.upsert(
        star(
            attachments=[
                {"id": "a1", "kind": "link", "file_name": None, "file_ext": None,
                 "url": "https://example.com/x", "link_title": "참고 링크", "path": None},
                {"id": "a2", "kind": "file", "file_name": "관측 노트.txt", "file_ext": "TXT",
                 "url": None, "link_title": None, "path": str(f)},
                {"id": "a3", "kind": "image", "file_name": "사진.png", "file_ext": "PNG",
                 "url": None, "link_title": None, "path": str(tmp_path / "사진.png")},
                {"id": "a4", "kind": "file", "file_name": "없음.pdf", "file_ext": "PDF",
                 "url": None, "link_title": None, "path": str(tmp_path / "없음.pdf")},
            ]
        )
    )
    docs = idx.chunks_for(["s1"])
    assert [d.id for d in docs] == [f"s1:{n}" for n in range(len(docs))]
    assert out["chunks"] == len(docs) == 7
    keys = {"star_id", "planet_id", "created_at", "source", "attachment_id", "file_name", "kind", "n"}
    for d in docs:
        assert keys <= set(d.metadata)
        assert d.metadata["star_id"] == "s1"
        assert d.metadata["planet_id"] == "p1"
        assert d.metadata["created_at"] == "2026-03-01T09:00:00.000Z"
    by_source = [d.metadata["source"] for d in docs]
    assert by_source == ["title", "body", "memo", "link", "file", "file", "file"]
    title = docs[0]
    assert "s1 제목" in title.page_content and "목성" in title.page_content
    assert title.metadata["attachment_id"] is None and title.metadata["kind"] is None
    link = docs[3]
    assert "참고 링크" in link.page_content and "https://example.com/x" in link.page_content
    assert link.metadata["attachment_id"] == "a1" and link.metadata["kind"] == "link"
    txt = docs[4]
    assert "관측 노트.txt" in txt.page_content and "토성 고리 관측 기록" in txt.page_content
    assert txt.metadata["file_name"] == "관측 노트.txt" and txt.metadata["kind"] == "file"
    img = docs[5]
    assert img.page_content.strip() == "사진.png" and img.metadata["kind"] == "image"
    assert out["notes"] == [
        {"attachment_id": "a3", "note": "unsupported"},
        {"attachment_id": "a4", "note": "error:missing"},
    ]


def test_remove_then_search_misses(idx):
    idx.upsert(star("s1"))
    idx.upsert(star("s2"))
    assert idx.remove(["s1", "nope"]) == 3
    hits = idx.search("s1 본문 글이에요.", k=10)
    assert hits and all(d.metadata["star_id"] == "s2" for d, _ in hits)
    assert idx.stats() == {"chunks": 3, "stars": 1}


def test_search_returns_scores_and_exact_match_first(idx):
    idx.upsert(star("s1"))
    idx.upsert(star("s2"))
    hits = idx.search("s2 메모", k=2)
    assert len(hits) == 2
    doc, score = hits[0]
    assert doc.page_content == "s2 메모"
    assert score == pytest.approx(1.0)


def test_search_result_metadata_is_a_copy(idx):
    idx.upsert(star())
    doc, _ = idx.search("s1 메모", k=1)[0]
    doc.metadata["star_id"] = "hacked"
    assert idx.search("s1 메모", k=1)[0][0].metadata["star_id"] == "s1"


def test_planet_filter(idx):
    idx.upsert(star("s1", planet="p1"))
    idx.upsert(star("s2", planet="p2"))
    hits = idx.search("본문", k=10, star_filter={"planet_id": "p2"})
    assert {d.metadata["star_id"] for d, _ in hits} == {"s2"}


def test_period_filter_from_inclusive_to_exclusive(idx):
    idx.upsert(star("jan", created="2026-01-15T00:00:00.000Z"))
    idx.upsert(star("feb", created="2026-02-01T00:00:00.000Z"))
    idx.upsert(star("mar", created="2026-03-01T00:00:00.000Z"))
    hits = idx.search(
        "본문", k=20, star_filter={"from": "2026-02-01T00:00:00.000Z", "to": "2026-03-01T00:00:00Z"}
    )
    assert {d.metadata["star_id"] for d, _ in hits} == {"feb"}
    hits = idx.search("본문", k=20, star_filter={"from": "2026-02-01T09:00:00+09:00"})
    assert {d.metadata["star_id"] for d, _ in hits} == {"feb", "mar"}


def test_excluded_planets_filter(idx):
    idx.upsert(star("s1", planet="p1"))
    idx.upsert(star("s2", planet="p2"))
    idx.upsert(star("s3", planet="p3"))
    hits = idx.search("본문", k=20, star_filter={"excluded_planets": ["p1", "p3"]})
    assert {d.metadata["star_id"] for d, _ in hits} == {"s2"}


def test_star_ids_and_callable_filter(idx):
    for s in ("s1", "s2", "s3"):
        idx.upsert(star(s))
    hits = idx.search("본문", k=20, star_filter={"star_ids": ["s1", "s3"]})
    assert {d.metadata["star_id"] for d, _ in hits} == {"s1", "s3"}
    hits = idx.search("본문", k=20, star_filter=lambda md: md["source"] == "memo")
    assert {d.metadata["source"] for d, _ in hits} == {"memo"}


def test_chunks_for_order(idx):
    idx.upsert(star("s1"))
    idx.upsert(star("s2"))
    ids = [d.id for d in idx.chunks_for(["s2", "s1", "s2", "none"])]
    assert ids == ["s2:0", "s2:1", "s2:2", "s1:0", "s1:1", "s1:2"]


def test_stars_matching(idx):
    idx.upsert(star("b", planet="p1", created="2026-02-01T00:00:00Z"))
    idx.upsert(star("a", planet="p1", created="2026-01-01T00:00:00Z"))
    idx.upsert(star("c", planet="p2", created="2026-01-05T00:00:00Z"))
    assert idx.stars_matching({"planet_id": "p1"}) == ["a", "b"]
    assert idx.stars_matching(None) == ["a", "c", "b"]


def test_empty_star_has_no_chunks(idx):
    idx.upsert(star())
    out = idx.upsert({"id": "s1", "title": "", "body": None, "attachments": []})
    assert out == {"chunks": 0, "notes": []}
    assert idx.stats() == {"chunks": 0, "stars": 0}


def test_bad_star_raises_value_error(idx):
    with pytest.raises(ValueError):
        idx.upsert({"title": "id 없음"})
    with pytest.raises(ValueError):
        idx.upsert({"id": "x:y"})  # 조각 id 와 헷갈리는 별 id


def test_reset(idx):
    idx.upsert(star())
    idx.reset()
    assert idx.stats() == {"chunks": 0, "stars": 0}
    assert idx.search("본문", k=5) == []


# ---------- 저장 · 불러오기 ----------


def test_flush_then_new_index_loads_same_chunks(data_dir, emb):
    a = StarIndex(data_dir, emb)
    a.upsert(star("s1"))
    a.upsert(star("s2"))
    assert a.flush() is True
    assert a.flush() is False  # 바뀐 게 없으면 다시 쓰지 않는다
    a.close()
    path = data_dir / "rag" / "index.json"
    assert path.is_file()
    assert not (data_dir / "rag" / "index.json.tmp").exists()

    b = StarIndex(data_dir, emb)
    assert b.stats() == {"chunks": 6, "stars": 2}
    # star_id → 조각 지도가 다시 만들어져 지우기가 정확하다
    assert b.remove(["s1"]) == 3
    assert [d.id for d in b.chunks_for(["s2"])] == ["s2:0", "s2:1", "s2:2"]
    b.close()


def test_debounced_save(data_dir, emb):
    a = StarIndex(data_dir, emb, save_delay=0.05)
    a.upsert(star())
    path = data_dir / "rag" / "index.json"
    assert not path.exists()
    done = threading.Event()
    for _ in range(100):
        if path.exists():
            done.set()
            break
        done.wait(0.05)
    assert done.is_set()
    a.close()


def test_saves_every_n_changes_during_bulk(data_dir, emb):
    a = StarIndex(data_dir, emb, save_delay=60, save_every=3)
    path = data_dir / "rag" / "index.json"
    a.upsert(star("s1"))
    a.upsert(star("s2"))
    assert not path.exists()
    a.upsert(star("s3"))
    assert path.exists()
    a.close()


def test_remove_and_reset_are_saved_right_away(data_dir, emb):
    a = StarIndex(data_dir, emb, save_delay=60)
    a.upsert(star("s1"))
    a.upsert(star("s2"))
    a.remove(["s1"])
    assert StarIndex(data_dir, emb).stats() == {"chunks": 3, "stars": 1}
    a.reset()
    assert StarIndex(data_dir, emb).stats() == {"chunks": 0, "stars": 0}
    a.close()


def test_close_flushes(data_dir, emb):
    a = StarIndex(data_dir, emb, save_delay=60)
    a.upsert(star())
    a.close()
    assert StarIndex(data_dir, emb).stats()["chunks"] == 3


@pytest.mark.parametrize("content", ["{ not json", "[1, 2, 3]", '{"x": {"id": "x"}}'])
def test_broken_index_is_moved_and_start_empty(data_dir, emb, content, capsys):
    rag = data_dir / "rag"
    rag.mkdir(parents=True)
    (rag / "index.json").write_text(content, encoding="utf-8")
    a = StarIndex(data_dir, emb)
    assert a.stats() == {"chunks": 0, "stars": 0}
    assert not (rag / "index.json").exists()
    broken = list(rag.glob("index.json.broken-*"))
    assert len(broken) == 1
    assert broken[0].read_text(encoding="utf-8") == content
    err = capsys.readouterr().err
    assert err.count("\n") == 1 and "Traceback" not in err
    # 다시 쓸 수 있다
    a.upsert(star())
    assert a.flush() is True
    a.close()


def test_leftover_tmp_does_not_break_load(data_dir, emb):
    a = StarIndex(data_dir, emb)
    a.upsert(star())
    a.flush()
    a.close()
    rag = data_dir / "rag"
    # 쓰다가 꺼진 것처럼 반쪽 tmp 만 남은 상황
    (rag / "index.json.tmp").write_text('{"half', encoding="utf-8")
    b = StarIndex(data_dir, emb)
    assert b.stats() == {"chunks": 3, "stars": 1}
    assert not (rag / "index.json.tmp").exists()
    b.close()


def test_only_tmp_present_starts_empty(data_dir, emb):
    rag = data_dir / "rag"
    rag.mkdir(parents=True)
    (rag / "index.json.tmp").write_text('{"half', encoding="utf-8")
    a = StarIndex(data_dir, emb)
    assert a.stats() == {"chunks": 0, "stars": 0}
    a.close()


def test_save_goes_through_tmp_then_replace(data_dir, emb, monkeypatch):
    import index as index_mod

    calls = []
    real_replace = index_mod.os.replace

    def spy(src, dst):
        calls.append((str(src), str(dst)))
        assert json.loads(open(src, encoding="utf-8").read())  # tmp 가 완전한 JSON
        real_replace(src, dst)

    monkeypatch.setattr(index_mod.os, "replace", spy)
    a = StarIndex(data_dir, emb)
    a.upsert(star())
    a.flush()
    rag = data_dir / "rag"
    assert calls == [(str(rag / "index.json.tmp"), str(rag / "index.json"))]
    a.close()


def test_failed_save_keeps_old_file_and_stays_dirty(data_dir, emb, monkeypatch):
    import index as index_mod

    a = StarIndex(data_dir, emb)
    a.upsert(star("s1"))
    a.flush()
    a.upsert(star("s2"))

    def boom(src, dst):
        raise PermissionError("locked")

    monkeypatch.setattr(index_mod.os, "replace", boom)
    monkeypatch.setattr(index_mod, "REPLACE_RETRY_DELAY", 0)
    with pytest.raises(OSError):
        a.flush()
    monkeypatch.undo()
    assert StarIndex(data_dir, emb).stats()["stars"] == 1
    assert a.flush() is True
    assert StarIndex(data_dir, emb).stats()["stars"] == 2
    a.close()


def test_concurrent_upserts_and_searches(idx):
    errors = []

    def writer(n):
        try:
            for i in range(15):
                idx.upsert(star(f"w{n}-{i % 5}"))
        except Exception as err:  # noqa: BLE001
            errors.append(err)

    def reader():
        try:
            for _ in range(30):
                idx.search("본문", k=5)
                idx.stats()
        except Exception as err:  # noqa: BLE001
            errors.append(err)

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(3)]
    threads += [threading.Thread(target=reader) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert idx.stats() == {"chunks": 45, "stars": 15}
