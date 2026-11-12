"""StarIndex: 별을 조각으로 넣고 · 지우고 · 찾고 · 모아 저장하기(가짜 임베딩)."""

import json
import threading

import pytest
from langchain_core.embeddings import DeterministicFakeEmbedding, Embeddings

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


def test_metadata_fields_and_ids(idx, data_dir):
    vault = data_dir / "vault"
    vault.mkdir()
    tmp_path = vault
    f = vault / "관측 노트.txt"
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


# ---------- 경쟁(race): 느린 임베딩으로 순서를 강제한다 ----------


class GatedEmbedding(Embeddings):
    """글에 표지(marker)가 들어 있으면 entered 를 켜고 release 가 켜질 때까지 멈춘다."""

    def __init__(self):
        self.inner = DeterministicFakeEmbedding(size=64)
        self.gates = {}

    def gate(self, marker):
        entered, release = threading.Event(), threading.Event()
        self.gates[marker] = (entered, release)
        return entered, release

    def _wait(self, texts):
        for marker, (entered, release) in list(self.gates.items()):
            if any(marker in t for t in texts):
                entered.set()
                assert release.wait(10)

    def embed_documents(self, texts):
        self._wait(texts)
        return self.inner.embed_documents(texts)

    def embed_query(self, text):
        self._wait([text])
        return self.inner.embed_query(text)


def _bg(fn, *args):
    out = {}

    def run():
        try:
            out["value"] = fn(*args)
        except Exception as err:  # noqa: BLE001
            out["error"] = err

    t = threading.Thread(target=run)
    t.start()
    return t, out


@pytest.fixture
def gated():
    return GatedEmbedding()


@pytest.mark.parametrize("existed", [True, False])
def test_upsert_racing_remove_does_not_resurrect(data_dir, gated, existed):
    a = StarIndex(data_dir, gated, save_delay=60)
    if existed:
        a.upsert(star("s1"))
    entered, release = gated.gate("SLOW")
    t, out = _bg(a.upsert, star("s1", body="SLOW 새 본문"))
    assert entered.wait(10)
    a.remove(["s1"])
    release.set()
    t.join(10)
    assert "error" not in out
    assert out["value"]["discarded"] is True
    assert out["value"]["chunks"] == 0
    assert a.stats() == {"chunks": 0, "stars": 0}
    a.close()
    assert StarIndex(data_dir, gated).stats() == {"chunks": 0, "stars": 0}


def test_upsert_racing_reset_is_discarded(data_dir, gated):
    a = StarIndex(data_dir, gated, save_delay=60)
    a.upsert(star("s1"))
    entered, release = gated.gate("SLOW")
    t, out = _bg(a.upsert, star("s2", body="SLOW 본문"))
    assert entered.wait(10)
    a.reset()
    release.set()
    t.join(10)
    assert out["value"]["discarded"] is True
    assert a.stats() == {"chunks": 0, "stars": 0}
    a.close()
    assert StarIndex(data_dir, gated).stats() == {"chunks": 0, "stars": 0}


def test_out_of_order_upserts_later_started_wins(data_dir, gated):
    a = StarIndex(data_dir, gated, save_delay=60)
    entered, release = gated.gate("OLD")
    t, out = _bg(a.upsert, star("s1", body="OLD 옛 본문"))
    assert entered.wait(10)
    newer = a.upsert(star("s1", body="NEW 새 본문"))
    assert "discarded" not in newer
    release.set()
    t.join(10)
    assert out["value"]["discarded"] is True
    bodies = [d.page_content for d in a.chunks_for(["s1"]) if d.metadata["source"] == "body"]
    assert bodies == ["NEW 새 본문"]
    a.close()


def test_upsert_after_remove_is_kept(idx):
    idx.upsert(star("s1"))
    idx.remove(["s1"])
    out = idx.upsert(star("s1"))
    assert out == {"chunks": 3, "notes": []}
    assert idx.stats() == {"chunks": 3, "stars": 1}


def test_search_embeds_outside_the_lock(data_dir, gated):
    a = StarIndex(data_dir, gated, save_delay=60)
    a.upsert(star("s1"))
    entered, release = gated.gate("QUERY")
    t, out = _bg(a.search, "QUERY 본문", 5)
    assert entered.wait(10)
    # 검색이 임베딩에서 멈춰 있어도 바꾸기 · 통계는 기다리지 않는다
    done = threading.Event()
    t2, _ = _bg(lambda: (a.upsert(star("s2")), done.set()))
    assert done.wait(5)
    assert a.stats() == {"chunks": 6, "stars": 2}
    release.set()
    t.join(10)
    t2.join(10)
    assert "error" not in out and out["value"]
    a.close()


def test_search_by_vector_still_filters(idx):
    idx.upsert(star("s1", planet="p1"))
    idx.upsert(star("s2", planet="p2"))
    hits = idx.search("s1 메모", k=10, star_filter={"planet_id": "p2"})
    assert hits and {d.metadata["star_id"] for d, _ in hits} == {"s2"}


# ---------- 실패한 저장 다시 하기 ----------


def _fail_replace_once(monkeypatch):
    import index as index_mod

    real = index_mod.os.replace
    calls = {"n": 0}

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("disk full")
        return real(src, dst)

    monkeypatch.setattr(index_mod.os, "replace", flaky)
    return calls


def test_failed_debounced_save_is_retried(data_dir, emb, monkeypatch):
    calls = _fail_replace_once(monkeypatch)
    a = StarIndex(data_dir, emb, save_delay=0.05, retry_delays=(0.05, 0.1))
    a.upsert(star())
    path = data_dir / "rag" / "index.json"
    done = threading.Event()
    for _ in range(100):
        if path.exists():
            done.set()
            break
        done.wait(0.05)
    assert done.is_set()
    assert calls["n"] == 2
    assert a.flush() is False  # 깨끗해졌다
    a.close()


def test_retry_delays_back_off(data_dir, emb):
    a = StarIndex(data_dir, emb)
    assert a.retry_delays == (5.0, 30.0)
    a.close()


def test_remove_flushes_when_dirty_even_if_nothing_removed(data_dir, emb):
    a = StarIndex(data_dir, emb, save_delay=60)
    a.upsert(star("s1"))
    assert a.remove(["nope"]) == 0
    assert StarIndex(data_dir, emb).stats() == {"chunks": 3, "stars": 1}
    a.close()


def test_remove_raises_when_immediate_save_fails(data_dir, emb, monkeypatch):
    a = StarIndex(data_dir, emb, save_delay=60, retry_delays=(60, 60))
    a.upsert(star("s1"))
    a.upsert(star("s2"))
    _fail_replace_once(monkeypatch)
    with pytest.raises(OSError):
        a.remove(["s1"])
    assert a.stats() == {"chunks": 3, "stars": 1}  # 메모리에서는 지워졌다
    assert a.remove([]) == 0  # 아직 dirty 이므로 다시 저장한다
    assert StarIndex(data_dir, emb).stats() == {"chunks": 3, "stars": 1}
    a.close()


def test_reset_raises_when_immediate_save_fails(data_dir, emb, monkeypatch):
    a = StarIndex(data_dir, emb, save_delay=60, retry_delays=(60, 60))
    a.upsert(star("s1"))
    _fail_replace_once(monkeypatch)
    with pytest.raises(OSError):
        a.reset()
    assert a.flush() is True
    assert StarIndex(data_dir, emb).stats() == {"chunks": 0, "stars": 0}
    a.close()


# ---------- 잠금 밖에서 저장 ----------


def test_saved_file_is_compact_and_round_trips(data_dir, emb):
    a = StarIndex(data_dir, emb, save_delay=60)
    a.upsert(star("s1"))
    a.upsert(star("s2", body="줄바꿈\n\n있는 본문"))
    a.flush()
    raw = (data_dir / "rag" / "index.json").read_text(encoding="utf-8")
    assert "\n" not in raw
    assert '": ' not in raw  # indent · 공백 없음
    b = StarIndex(data_dir, emb)
    assert b.stats() == a.stats()
    for sid in ("s1", "s2"):
        assert [(d.id, d.page_content, d.metadata) for d in b.chunks_for([sid])] == [
            (d.id, d.page_content, d.metadata) for d in a.chunks_for([sid])
        ]
    assert b.search("s2 메모", k=1)[0][0].page_content == "s2 메모"
    a.close()
    b.close()


def test_save_writes_outside_the_lock_and_stays_dirty_if_changed(data_dir, emb, monkeypatch):
    import index as index_mod

    a = StarIndex(data_dir, emb, save_delay=60)
    a.upsert(star("s1"))
    writing, go = threading.Event(), threading.Event()
    real = index_mod.os.replace

    def slow_replace(src, dst):
        writing.set()
        assert go.wait(10)
        return real(src, dst)

    monkeypatch.setattr(index_mod.os, "replace", slow_replace)
    t, out = _bg(a.flush)
    assert writing.wait(10)
    # 저장이 파일을 쓰는 중에도 바꾸기 · 찾기가 된다
    done = threading.Event()
    t2, _ = _bg(lambda: (a.upsert(star("s2")), a.search("본문", 3), done.set()))
    assert done.wait(5)
    go.set()
    t.join(10)
    t2.join(10)
    assert out["value"] is True
    monkeypatch.undo()
    # s2 는 저장 뒤에 들어왔으므로 아직 dirty
    assert StarIndex(data_dir, emb).stats() == {"chunks": 3, "stars": 1}
    assert a.flush() is True
    assert StarIndex(data_dir, emb).stats() == {"chunks": 6, "stars": 2}
    a.close()


# ---------- 첨부 경로는 <data_dir>/vault 안이어야 한다 ----------


def test_attachment_outside_vault_is_not_read(idx, data_dir, tmp_path):
    vault = data_dir / "vault"
    vault.mkdir()
    inside = vault / "안.txt"
    inside.write_text("보관함 안 글", encoding="utf-8")
    secret = data_dir / ".env"  # 가짜 .env (진짜 .env 는 건드리지 않는다)
    secret.write_text("SECRET=sk-outside", encoding="utf-8")
    outside = tmp_path / "밖.txt"
    outside.write_text("보관함 밖 글", encoding="utf-8")
    atts = [
        {"id": "a1", "kind": "file", "file_name": "안.txt", "file_ext": "txt", "path": str(inside)},
        {"id": "a2", "kind": "file", "file_name": ".env", "file_ext": "txt",
         "path": str(vault) + "\\..\\.env"},
        {"id": "a3", "kind": "file", "file_name": "env2.txt", "file_ext": "txt", "path": "vault\\..\\.env"},
        {"id": "a4", "kind": "file", "file_name": "밖.txt", "file_ext": "txt", "path": str(outside)},
        {"id": "a5", "kind": "file", "file_name": "상대.txt", "file_ext": "txt", "path": "vault/안.txt"},
    ]
    out = idx.upsert(star(attachments=atts))
    assert out["notes"] == [
        {"attachment_id": "a2", "note": "error:outside_vault"},
        {"attachment_id": "a3", "note": "error:outside_vault"},
        {"attachment_id": "a4", "note": "error:outside_vault"},
    ]
    files = [d.page_content for d in idx.chunks_for(["s1"]) if d.metadata["source"] == "file"]
    assert files == ["안.txt\n보관함 안 글", ".env", "env2.txt", "밖.txt", "상대.txt\n보관함 안 글"]
    assert not any("sk-outside" in c or "밖 글" in c for c in files)
