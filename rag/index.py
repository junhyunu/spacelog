"""별 하나하나를 조각으로 나눠 벡터 색인(InMemoryVectorStore)에 넣고 · 지우고 · 찾는다.

- 조각 id 는 "<star_id>:<n>" (n 은 0부터). star_id → 조각 id 목록 지도를 따로 둬 지우기가 정확하다.
- Flask 는 여러 스레드로 돌므로 바꾸기 · 찾기 · 저장은 RLock 하나 안에서 한다.
  (파일에서 글 뽑기와 조각 임베딩은 잠금 밖에서 하고, 다 만든 조각만 잠금 안에서 바꿔 단다.)
- 저장: 마지막 변경 5초 뒤(Timer 를 다시 건다), 변경이 save_every 개 쌓이면 바로, flush() · close() 에서.
  지우기 · 처음부터 다시(reset)는 바로 저장한다(되살아난 조각을 Node 가 다시 지울 길이 없으므로).
  index.json.tmp 에 쓰고 fsync 한 뒤 os.replace 로 바꿔 단다.
"""

import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from langchain_core.documents import Document
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_text_splitters import RecursiveCharacterTextSplitter

from extract import extract_text, normalize_ext

SEPARATORS = ["\n\n", "\n", ". ", "。", " ", ""]
SAVE_DELAY = 5.0
SAVE_EVERY = 50
REPLACE_RETRIES = 5
REPLACE_RETRY_DELAY = 0.1
INDEX_FILE = "index.json"


class BadStar(ValueError):
    """요청한 별 모양이 틀렸다(400)."""


def _log(message):
    print(f"rag index: {message}", file=sys.stderr, flush=True)


def _parse_time(value):
    """ISO 시각 → UTC aware datetime. 시간대가 없으면 UTC 로 본다. 못 읽으면 None."""
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def make_filter(star_filter):
    """star_filter → metadata 를 받는 판정 함수(또는 None).

    star_filter 는 None, metadata 를 받는 함수, 또는 dict:
      planet_id        이 행성만
      excluded_planets 이 행성들은 빼기
      star_ids         이 별들만
      from / to        created_at 기간(from 포함, to 미포함, ISO)
    """
    if star_filter is None:
        return None
    if callable(star_filter):
        return lambda md: bool(star_filter(md))
    if not isinstance(star_filter, dict):
        raise ValueError("star_filter must be a dict or callable")

    planet_id = star_filter.get("planet_id")
    excluded = set(star_filter.get("excluded_planets") or [])
    star_ids = star_filter.get("star_ids")
    star_ids = set(star_ids) if star_ids is not None else None
    start = _parse_time(star_filter.get("from")) if star_filter.get("from") else None
    end = _parse_time(star_filter.get("to")) if star_filter.get("to") else None
    if (star_filter.get("from") and start is None) or (star_filter.get("to") and end is None):
        raise ValueError("invalid period")

    def check(md):
        if planet_id is not None and md.get("planet_id") != planet_id:
            return False
        if md.get("planet_id") in excluded:
            return False
        if star_ids is not None and md.get("star_id") not in star_ids:
            return False
        if start is not None or end is not None:
            created = _parse_time(md.get("created_at"))
            if created is None:
                return False
            if start is not None and created < start:
                return False
            if end is not None and created >= end:
                return False
        return True

    return check


def _text(value):
    return value.strip() if isinstance(value, str) else ""


class StarIndex:
    def __init__(
        self,
        data_dir,
        embeddings,
        chunk_size=800,
        chunk_overlap=100,
        *,
        save_delay=SAVE_DELAY,
        save_every=SAVE_EVERY,
    ):
        self.dir = Path(data_dir) / "rag"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / INDEX_FILE
        self.tmp_path = self.dir / (INDEX_FILE + ".tmp")
        self.embeddings = embeddings
        self.save_delay = save_delay
        self.save_every = save_every
        self._splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size, chunk_overlap=chunk_overlap, separators=SEPARATORS
        )
        self._lock = threading.RLock()
        self._timer = None
        self._dirty = False
        self._pending = 0
        self._closed = False
        self._store = self._load()
        self._by_star = self._build_map()

    # ---------- 불러오기 ----------

    def _load(self):
        # 쓰다가 꺼져 남은 tmp 는 반쪽일 수 있다. index.json(마지막 완성본)을 믿고 tmp 는 버린다.
        try:
            self.tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        if not self.path.exists():
            return InMemoryVectorStore(self.embeddings)
        try:
            store = InMemoryVectorStore.load(str(self.path), self.embeddings)
            self._validate(store.store)
            return store
        except Exception as err:  # noqa: BLE001 — 깨진 파일이면 옮겨 두고 빈 색인으로
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            broken = self.dir / f"{INDEX_FILE}.broken-{stamp}"
            try:
                os.replace(self.path, broken)
                where = broken.name
            except OSError:
                where = "(could not move)"
            _log(f"{INDEX_FILE} unreadable ({type(err).__name__}), moved to {where}, starting empty")
            return InMemoryVectorStore(self.embeddings)

    @staticmethod
    def _validate(store):
        if not isinstance(store, dict):
            raise ValueError("store is not an object")
        for key, item in store.items():
            if not isinstance(item, dict) or item.get("id") != key:
                raise ValueError("bad entry")
            if not isinstance(item.get("vector"), list) or not isinstance(item.get("text"), str):
                raise ValueError("bad entry")
            md = item.get("metadata")
            if not isinstance(md, dict) or not isinstance(md.get("star_id"), str):
                raise ValueError("bad entry")

    def _build_map(self):
        by_star = {}
        for key, item in self._store.store.items():
            by_star.setdefault(item["metadata"]["star_id"], []).append(key)
        for ids in by_star.values():
            ids.sort(key=_chunk_no)
        return by_star

    # ---------- 조각 만들기 ----------

    def _split(self, text):
        return [c for c in self._splitter.split_text(text) if c.strip()]

    def build_documents(self, star):
        """star dict → (Document 목록, notes). 파일을 읽지만 색인은 건드리지 않는다."""
        if not isinstance(star, dict):
            raise BadStar("star must be an object")
        star_id = star.get("id")
        if not isinstance(star_id, str) or not star_id or ":" in star_id:
            raise BadStar("star.id must be a non-empty string without ':'")
        attachments = star.get("attachments") or []
        if not isinstance(attachments, list):
            raise BadStar("star.attachments must be a list")

        base = {
            "star_id": star_id,
            "planet_id": star.get("planet_id"),
            "created_at": star.get("created_at"),
        }
        pieces = []  # (page_content, extra metadata)

        def add(contents, source, att=None):
            for content in contents:
                pieces.append(
                    (
                        content,
                        {
                            "source": source,
                            "attachment_id": att.get("id") if att else None,
                            "file_name": (att.get("file_name") or None) if att else None,
                            "kind": att.get("kind") if att else None,
                        },
                    )
                )

        title = _text(star.get("title"))
        planet_name = _text(star.get("planet_name"))
        head = "\n".join(x for x in (title, f"행성: {planet_name}" if planet_name else "") if x)
        if head:
            add(self._split(head), "title")
        add(self._split(_text(star.get("body"))), "body")
        add(self._split(_text(star.get("memo"))), "memo")

        notes = []
        for att in attachments:
            if not isinstance(att, dict):
                continue
            kind = att.get("kind")
            if kind == "link":
                text = "\n".join(x for x in (_text(att.get("link_title")), _text(att.get("url"))) if x)
                add(self._split(text), "link", att)
                continue
            if kind not in ("file", "image"):
                continue
            name = _text(att.get("file_name"))
            note = None
            extracted = ""
            if kind == "image":
                note = "unsupported"
            elif not _text(att.get("path")):
                note = "error:missing"
            else:
                ext = normalize_ext(att.get("file_ext"), name or att.get("path"))
                extracted, note = extract_text(att["path"], ext)
            if note:
                notes.append({"attachment_id": att.get("id"), "note": note})
            chunks = self._split(extracted) if extracted else []
            if chunks:
                add([f"{name}\n{c}" if name else c for c in chunks], "file", att)
            elif name:
                add([name], "file", att)

        docs = []
        for n, (content, extra) in enumerate(pieces):
            md = dict(base)
            md.update(extra)
            md["n"] = n
            docs.append(Document(id=f"{star_id}:{n}", page_content=content, metadata=md))
        return docs, notes

    # ---------- 바꾸기 ----------

    def upsert(self, star):
        docs, notes = self.build_documents(star)
        star_id = star["id"]
        ids = [d.id for d in docs]
        # 임베딩은 잠금 밖에서(따로 만든 저장소에 add_documents) — 검색이 기다리지 않게.
        staged = InMemoryVectorStore(self.embeddings)
        if docs:
            staged.add_documents(docs, ids=ids)
        with self._lock:
            old = self._by_star.pop(star_id, [])
            self._store.delete(old)
            self._store.store.update(staged.store)
            if ids:
                self._by_star[star_id] = ids
            self._changed(1)
        return {"chunks": len(ids), "notes": notes}

    def remove(self, star_ids):
        removed = 0
        with self._lock:
            for star_id in dict.fromkeys(star_ids):
                old = self._by_star.pop(star_id, [])
                self._store.delete(old)
                removed += len(old)
            if removed:
                self._changed(0)
                self.flush()
        return removed

    def reset(self):
        with self._lock:
            self._store.store.clear()
            self._by_star.clear()
            self._changed(0)
            self.flush()

    def stats(self):
        with self._lock:
            return {"chunks": len(self._store.store), "stars": len(self._by_star)}

    # ---------- 찾기 ----------

    def search(self, query, k=8, star_filter=None):
        check = make_filter(star_filter)
        kwargs = {}
        if check is not None:
            kwargs["filter"] = lambda doc: check(doc.metadata)
        with self._lock:
            hits = self._store.similarity_search_with_score(query, k=k, **kwargs)
        return [(_copy(doc), score) for doc, score in hits]

    def chunks_for(self, star_ids):
        """별들의 조각 전부. 주어진 별 순서(중복은 한 번), 별 안에서는 n 순서."""
        with self._lock:
            out = []
            for star_id in dict.fromkeys(star_ids):
                out.extend(self._store.get_by_ids(self._by_star.get(star_id, [])))
        return [_copy(d) for d in out]

    def stars_matching(self, star_filter=None):
        """필터에 맞는 별 id 목록(created_at, star_id 순). 요약 대상 고르기용."""
        check = make_filter(star_filter)
        with self._lock:
            firsts = []
            for star_id, ids in self._by_star.items():
                md = self._store.store[ids[0]]["metadata"]
                if check is None or check(md):
                    firsts.append((_parse_time(md.get("created_at")), star_id))
        floor = datetime.min.replace(tzinfo=timezone.utc)
        firsts.sort(key=lambda x: (x[0] or floor, x[1]))
        return [star_id for _, star_id in firsts]

    # ---------- 저장 ----------

    def _changed(self, count):
        self._dirty = True
        self._pending += count
        if self._pending >= self.save_every:
            try:
                self.flush()
            except OSError:
                pass  # 로그는 _save 가 남겼다. 다음 타이머 · flush 에서 다시 쓴다.
            if not self._dirty:
                return
        self._schedule()

    def _schedule(self):
        if self._closed:
            return
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(self.save_delay, self._on_timer)
        self._timer.daemon = True
        self._timer.start()

    def _on_timer(self):
        try:
            self.flush()
        except Exception:  # noqa: BLE001 — _save 가 로그를 남겼다
            with self._lock:
                self._schedule()

    def flush(self):
        """바뀐 게 있으면 지금 저장한다. 저장했으면 True. 실패하면 OSError 를 그대로 올린다."""
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            if not self._dirty:
                return False
            self._save()
            self._dirty = False
            self._pending = 0
            return True

    def _save(self):
        try:
            self._store.dump(str(self.tmp_path))
            with open(self.tmp_path, "rb+") as f:
                os.fsync(f.fileno())
            for attempt in range(REPLACE_RETRIES):
                try:
                    os.replace(self.tmp_path, self.path)
                    break
                except PermissionError:
                    # Windows: 백신 · 검색 색인이 잠깐 파일을 잡고 있을 수 있다.
                    if attempt == REPLACE_RETRIES - 1:
                        raise
                    time.sleep(REPLACE_RETRY_DELAY)
        except OSError as err:
            _log(f"save failed ({type(err).__name__})")
            try:
                self.tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def close(self):
        """타이머를 멈추고 남은 변경을 저장한다(프로세스가 끝날 때)."""
        with self._lock:
            self._closed = True
            try:
                self.flush()
            except OSError:
                pass


def _chunk_no(chunk_id):
    try:
        return int(chunk_id.rsplit(":", 1)[1])
    except (IndexError, ValueError):
        return 0


def _copy(doc):
    return Document(id=doc.id, page_content=doc.page_content, metadata=dict(doc.metadata))
