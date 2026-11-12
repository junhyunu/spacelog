"""별 하나하나를 조각으로 나눠 벡터 색인(InMemoryVectorStore)에 넣고 · 지우고 · 찾는다.

- 조각 id 는 "<star_id>:<n>" (n 은 0부터). star_id → 조각 id 목록 지도를 따로 둬 지우기가 정확하다.
- Flask 는 여러 스레드로 돌므로 색인을 바꾸고 읽는 일은 RLock 하나 안에서 한다.
  느린 일(파일에서 글 뽑기, 조각 · 질문 임베딩, 파일 쓰기)은 잠금 밖에서 한다.
- 순서: upsert 는 시작할 때 번호표(ticket)를 받는다. 다 만든 조각을 달 때 그 번호표가 그 별의
  마지막 번호표이고, 그 사이 reset 이 없었고, 그 사이 remove 되지 않았을 때만 단다.
  아니면 결과를 버리고 {"chunks": 0, "notes": [...], "discarded": True} 를 돌려준다.
  (지운 별이 되살아나거나, 늦게 끝난 옛 upsert 가 새 내용을 덮지 않게.)
- 저장: 마지막 변경 5초 뒤(Timer 를 다시 건다), 변경이 save_every 개 쌓이면 바로, flush() · close() 에서.
  지우기 · 처음부터 다시(reset)는 바뀐 게 있으면 바로 저장하고, 실패하면 OSError 를 올린다
  (되살아난 조각을 Node 가 다시 지울 길이 없으므로 실패를 알려야 한다).
  저장이 실패하면 dirty 로 두고 5초, 그다음부터 30초 뒤에 다시 한다.
  잠금 안에서는 항목 사본과 판(version)만 뜨고, JSON 만들기 · 쓰기는 잠금 밖에서 한다.
  index.json.tmp 에 쓰고 fsync 한 뒤 os.replace 로 바꿔 단다.
- 첨부 path 는 <data_dir>/vault/ 안이어야 읽는다. 밖이면 읽지 않고 note "error:outside_vault".
"""

import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from langchain_core.documents import Document
from langchain_core.load import dumps
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_text_splitters import RecursiveCharacterTextSplitter

from extract import extract_text, normalize_ext

SEPARATORS = ["\n\n", "\n", ". ", "。", " ", ""]
SAVE_DELAY = 5.0
SAVE_EVERY = 50
RETRY_DELAYS = (5.0, 30.0)
REPLACE_RETRIES = 5
REPLACE_RETRY_DELAY = 0.1
INDEX_FILE = "index.json"
VAULT_DIR = "vault"


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


def _check_star(star):
    """별 모양을 확인하고 star_id 를 돌려준다(틀리면 BadStar)."""
    if not isinstance(star, dict):
        raise BadStar("star must be an object")
    star_id = star.get("id")
    if not isinstance(star_id, str) or not star_id or ":" in star_id:
        raise BadStar("star.id must be a non-empty string without ':'")
    if not isinstance(star.get("attachments") or [], list):
        raise BadStar("star.attachments must be a list")
    return star_id


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
        retry_delays=RETRY_DELAYS,
    ):
        self.data_dir = Path(data_dir)
        self.dir = self.data_dir / "rag"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / INDEX_FILE
        self.tmp_path = self.dir / (INDEX_FILE + ".tmp")
        self.embeddings = embeddings
        self.save_delay = save_delay
        self.save_every = save_every
        self.retry_delays = tuple(retry_delays)
        self._splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size, chunk_overlap=chunk_overlap, separators=SEPARATORS
        )
        self._lock = threading.RLock()
        # 저장은 한 번에 하나만(같은 tmp 파일을 쓴다). 순서: _save_lock → _lock. 거꾸로 잡지 않는다.
        self._save_lock = threading.Lock()
        self._timer = None
        self._dirty = False
        self._pending = 0
        self._version = 0  # 바뀔 때마다 1 씩. 저장한 판과 같을 때만 깨끗하다고 본다.
        self._failures = 0  # 연달아 실패한 저장 수(다시 하기 간격)
        self._closed = False
        # upsert 순서 지키기
        self._seq = 0  # 번호표 발급기
        self._latest = {}  # star_id → 마지막 번호표(그 별의 upsert 가 진행 중일 때만 있다)
        self._inflight = {}  # star_id → 진행 중인 upsert 수
        self._epoch = 0  # reset 때마다 1 씩
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

    def _vault_file(self, raw):
        """첨부 path → <data_dir>/vault 안의 실제 경로(Path). 밖이거나 이상하면 None.

        상대 경로는 data_dir 기준. resolve() 로 '..' · 링크를 풀고 나서 확인한다.
        """
        try:
            vault = (self.data_dir / VAULT_DIR).resolve()
            p = Path(raw)
            if not p.is_absolute():
                p = self.data_dir / p
            resolved = p.resolve()
        except (OSError, RuntimeError, ValueError):
            return None
        if resolved == vault or not resolved.is_relative_to(vault):
            return None
        return resolved

    def build_documents(self, star):
        """star dict → (Document 목록, notes). 파일을 읽지만 색인은 건드리지 않는다."""
        star_id = _check_star(star)
        attachments = star.get("attachments") or []

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
                path = self._vault_file(att["path"])
                if path is None:
                    note = "error:outside_vault"
                else:
                    ext = normalize_ext(att.get("file_ext"), name or att.get("path"))
                    extracted, note = extract_text(path, ext)
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
        star_id = _check_star(star)
        with self._lock:
            self._seq += 1
            ticket = self._seq
            epoch = self._epoch
            self._latest[star_id] = ticket
            self._inflight[star_id] = self._inflight.get(star_id, 0) + 1
        save_now = False
        try:
            docs, notes = self.build_documents(star)
            ids = [d.id for d in docs]
            # 임베딩은 잠금 밖에서(따로 만든 저장소에 add_documents) — 검색이 기다리지 않게.
            staged = InMemoryVectorStore(self.embeddings)
            if docs:
                staged.add_documents(docs, ids=ids)
            with self._lock:
                if self._latest.get(star_id) != ticket or self._epoch != epoch:
                    # 그 사이 더 새 upsert · remove · reset 이 있었다. 이 결과는 낡았다.
                    return {"chunks": 0, "notes": notes, "discarded": True}
                old = self._by_star.pop(star_id, [])
                self._store.delete(old)
                self._store.store.update(staged.store)
                if ids:
                    self._by_star[star_id] = ids
                save_now = self._changed(1)
        finally:
            with self._lock:
                left = self._inflight[star_id] - 1
                if left:
                    self._inflight[star_id] = left
                else:
                    del self._inflight[star_id]
                    self._latest.pop(star_id, None)
        if save_now:
            try:
                self.flush()
            except OSError:
                pass  # 로그는 _write 가 남겼고, flush 가 다시 하기를 걸어 두었다.
        return {"chunks": len(ids), "notes": notes}

    def remove(self, star_ids):
        """별들을 지우고 지운 조각 수를 돌려준다. 바뀐 게 있으면 바로 저장하고, 실패하면 OSError."""
        removed = 0
        with self._lock:
            for star_id in dict.fromkeys(star_ids):
                if star_id in self._latest:  # 진행 중인 upsert 를 낡게 만든다
                    self._seq += 1
                    self._latest[star_id] = self._seq
                old = self._by_star.pop(star_id, [])
                self._store.delete(old)
                removed += len(old)
            if removed:
                self._changed(0)
            dirty = self._dirty
        if dirty:
            self.flush()
        return removed

    def reset(self):
        """전부 지우고 바로 저장한다. 저장이 실패하면 OSError."""
        with self._lock:
            self._epoch += 1
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
        # 질문 임베딩(네트워크)은 잠금 밖에서.
        vector = self.embeddings.embed_query(query)
        with self._lock:
            hits = self._store.similarity_search_with_score_by_vector(vector, k=k, **kwargs)
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
        """잠금 안에서 부른다. 지금 바로 저장해야 하면 True(부른 쪽이 잠금 밖에서 flush)."""
        self._dirty = True
        self._version += 1
        self._pending += count
        if self._pending >= self.save_every:
            return True
        self._schedule(self.save_delay)
        return False

    def _schedule(self, delay):
        if self._closed:
            return
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(delay, self._on_timer)
        self._timer.daemon = True
        self._timer.start()

    def _on_timer(self):
        try:
            self.flush()
        except Exception:  # noqa: BLE001 — _write 가 로그를 남겼고 flush 가 다시 하기를 걸었다
            pass

    def flush(self):
        """바뀐 게 있으면 지금 저장한다. 저장했으면 True.

        실패하면 dirty 로 두고 다시 하기를 건 뒤 OSError 를 그대로 올린다.
        """
        with self._save_lock:
            with self._lock:
                if self._timer is not None:
                    self._timer.cancel()
                    self._timer = None
                if not self._dirty:
                    return False
                # 항목 dict 는 바꿔 끼우기만 하고 안을 고치지 않으므로 얕은 사본이면 된다.
                snapshot = dict(self._store.store)
                version = self._version
            try:
                self._write(snapshot)
            except OSError:
                with self._lock:
                    self._failures += 1
                    step = min(self._failures, len(self.retry_delays)) - 1
                    self._schedule(self.retry_delays[step])
                raise
            with self._lock:
                self._failures = 0
                if self._version == version:
                    self._dirty = False
                    self._pending = 0
                # 쓰는 동안 바뀌었으면 dirty 로 둔다(그 변경이 타이머를 걸어 두었다).
            return True

    def _write(self, snapshot):
        """잠금 없이 부른다. InMemoryVectorStore.dump 와 같은 구조를 들여쓰기 없이 쓴다."""
        try:
            data = dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
            with open(self.tmp_path, "w", encoding="utf-8") as f:
                f.write(data)
                f.flush()
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
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
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
