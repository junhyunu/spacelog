"""질문에 답하기: 질문 풀기(계획) → find / ask / summarize / chat. 모두 이벤트(dict)를 내는 생성기다.

이벤트(app.py 가 한 줄에 JSON 하나씩 흘려 보낸다):
  {"type":"plan","intent":..,"from":ISO|null,"to":ISO|null,"planet_id":id|null,"star_ids":[..]}
  {"type":"progress","step":i,"total":n}    요약 묶음을 하나 끝낼 때마다(긴 요약만)
  {"type":"token","text":".."}
  {"type":"replace","text":".."}            이미 보낸 글을 통째로 바꾼다
  {"type":"sources","stars":[{"star_id","attachment_id","file_name"}]}
  {"type":"done","not_found":bool}  또는  {"type":"error","code":..,"message":..}

출처는 코드가 붙인다: ask 는 모델이 마지막 줄 "사용한 조각: 1, 3" 으로 낸 번호 중 실제로 준 번호만,
find 는 찾은 조각의 별, summarize 는 대상 별. 마지막 줄은 흘려 보내는 중에도 밖으로 내보내지 않는다.
"""

import json
import re
import sys
from contextlib import closing
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

import prompts

INTENTS = ("find", "ask", "summarize", "chat")
MAX_QUESTION = 2000
MAX_HISTORY = 6
MAX_HISTORY_CHARS = 2000
MAX_TZ_OFFSET = 14 * 60
MAX_PLAN_STARS = 50
FIND_MAX = 8
SUMMARY_MAX_STARS = 200
SUMMARY_ONE_CALL = 24_000
SUMMARY_BATCH = 12_000
SUMMARY_SOURCES = 20

NOT_FOUND = "기록에서 찾지 못했어요."
TOO_BROAD = "범위가 너무 넓어요. 기간이나 행성을 좁혀 주세요."
FAILED = "답을 만들지 못했어요"
WEEKDAYS = "월화수목금토일"


class BadRequest(ValueError):
    def __init__(self, field_name):
        super().__init__(field_name)
        self.field = field_name


class ModelError(Exception):
    """모델(채팅 · 임베딩) 호출이 실패했다. 원인은 로그에 종류만 남긴다."""


# ---------- 요청 ----------


@dataclass
class AnswerRequest:
    question: str
    today: date
    tz_offset_min: int  # 현지 시각 - UTC (분). 한국은 +540 = -new Date().getTimezoneOffset()
    history: list = field(default_factory=list)  # [(role, content)]
    context: dict = field(default_factory=dict)  # planet_id · planet_name · star_id
    excluded_planets: list = field(default_factory=list)
    planets: list = field(default_factory=list)  # [(id, name)]

    @property
    def tz(self):
        return timezone(timedelta(minutes=self.tz_offset_min))


def _opt_str(value, name):
    if value is None:
        return None
    if not isinstance(value, str):
        raise BadRequest(name)
    return value.strip() or None


def parse_request(data):
    """POST /answer 본문 → AnswerRequest. 틀리면 BadRequest(필드 이름)."""
    if not isinstance(data, dict):
        raise BadRequest("body")

    question = data.get("question")
    if not isinstance(question, str) or not question.strip():
        raise BadRequest("question")
    question = question.strip()
    if len(question) > MAX_QUESTION:
        raise BadRequest("question")

    today_raw = data.get("today")
    if not isinstance(today_raw, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", today_raw):
        raise BadRequest("today")
    try:
        today = date.fromisoformat(today_raw)
    except ValueError:
        raise BadRequest("today") from None

    tz = data.get("tz_offset_min")
    if isinstance(tz, bool) or not isinstance(tz, int) or abs(tz) > MAX_TZ_OFFSET:
        raise BadRequest("tz_offset_min")

    history_raw = data.get("history") or []
    if not isinstance(history_raw, list):
        raise BadRequest("history")
    history = []
    for item in history_raw:
        if (
            not isinstance(item, dict)
            or item.get("role") not in ("user", "assistant")
            or not isinstance(item.get("content"), str)
        ):
            raise BadRequest("history")
        history.append((item["role"], item["content"][:MAX_HISTORY_CHARS]))
    history = history[-MAX_HISTORY:]

    ctx_raw = data.get("context") or {}
    if not isinstance(ctx_raw, dict):
        raise BadRequest("context")
    context = {k: _opt_str(ctx_raw.get(k), "context") for k in ("planet_id", "planet_name", "star_id")}

    excluded = data.get("excluded_planets") or []
    if not isinstance(excluded, list) or not all(isinstance(x, str) for x in excluded):
        raise BadRequest("excluded_planets")

    planets_raw = data.get("planets") or []
    if not isinstance(planets_raw, list):
        raise BadRequest("planets")
    planets = []
    for p in planets_raw:
        if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not isinstance(p.get("name", ""), str):
            raise BadRequest("planets")
        planets.append((p["id"], p.get("name") or ""))

    return AnswerRequest(
        question=question,
        today=today,
        tz_offset_min=tz,
        history=history,
        context=context,
        excluded_planets=list(dict.fromkeys(excluded)),
        planets=planets,
    )


# ---------- 계획 ----------


@dataclass
class Plan:
    intent: str = "ask"
    query: str = ""
    start: str | None = None  # ISO, 시간대 포함(현지 자정)
    end: str | None = None  # ISO, 미포함
    planet_id: str | None = None
    star_ids: list = field(default_factory=list)

    def event(self):
        return {
            "type": "plan",
            "intent": self.intent,
            "from": self.start,
            "to": self.end,
            "planet_id": self.planet_id,
            "star_ids": list(self.star_ids),
        }

    def has_scope(self):
        return bool(self.start or self.end or self.planet_id or self.star_ids)

    def star_filter(self, req, with_stars=True):
        f = {"excluded_planets": list(req.excluded_planets)}
        if self.planet_id:
            f["planet_id"] = self.planet_id
        if self.start:
            f["from"] = self.start
        if self.end:
            f["to"] = self.end
        if with_stars and self.star_ids:
            f["star_ids"] = list(self.star_ids)
        return f


def parse_plan_json(raw):
    """모델 글 → dict. 코드 블록 표시를 벗기고 처음 나오는 {…} 를 읽는다. 못 읽으면 {}."""
    if not isinstance(raw, str):
        return {}
    text = re.sub(r"```[a-zA-Z]*", "", raw)
    start = text.find("{")
    while start != -1:
        try:
            obj, _ = json.JSONDecoder().raw_decode(text[start:])
        except ValueError:
            start = text.find("{", start + 1)
            continue
        return obj if isinstance(obj, dict) else {}
    return {}


def _plan_date(value):
    if not isinstance(value, str):
        return None
    m = re.match(r"\s*(\d{4}-\d{2}-\d{2})", value)
    if not m:
        return None
    try:
        return date.fromisoformat(m.group(1))
    except ValueError:
        return None


def _local_midnight(d, req):
    return datetime(d.year, d.month, d.day, tzinfo=req.tz).isoformat()


_THIS_PLANET = re.compile(r"이\s*행성")
_THIS_STAR = re.compile(r"이\s*(별|기록)(?!들)")


def build_plan(data, req, index=None):
    """모델이 낸 dict 를 검사해 Plan 으로. 모르는 값은 버린다."""
    if not isinstance(data, dict):
        data = {}
    plan = Plan()
    intent = data.get("intent")
    plan.intent = intent if intent in INTENTS else "ask"
    query = data.get("query")
    plan.query = query.strip()[:500] if isinstance(query, str) else ""

    # 기간: 모델은 현지 날짜(둘 다 포함)를 낸다 → [from 자정, to 다음 날 자정)
    d_from, d_to = _plan_date(data.get("from")), _plan_date(data.get("to"))
    if d_from and d_to and d_from > d_to:
        d_from = d_to = None
    try:
        plan.start = _local_midnight(d_from, req) if d_from else None
        plan.end = _local_midnight(d_to + timedelta(days=1), req) if d_to else None
    except (OverflowError, ValueError):
        plan.start = plan.end = None

    # 행성: 목록에 있고 빼 두지 않은 것만. id 대신 이름을 내도 받는다.
    excluded = set(req.excluded_planets)
    allowed = {pid: name for pid, name in req.planets if pid not in excluded}
    by_name = {name: pid for pid, name in allowed.items() if name}
    this = data.get("this")
    raw_planet = data.get("planet_id")
    planet_id = None
    if isinstance(raw_planet, str):
        planet_id = raw_planet if raw_planet in allowed else by_name.get(raw_planet.strip())
    if this == "planet" or _THIS_PLANET.search(req.question):
        ctx_planet = req.context.get("planet_id")
        if ctx_planet in allowed:
            planet_id = ctx_planet
    plan.planet_id = planet_id

    # 별: 색인에 있고 빼 둔 행성이 아닌 것만(준 순서 유지).
    raw_stars = data.get("star_ids")
    ids = [s for s in raw_stars if isinstance(s, str) and s] if isinstance(raw_stars, list) else []
    if this == "star" or _THIS_STAR.search(req.question):
        if req.context.get("star_id"):
            ids.insert(0, req.context["star_id"])
    ids = list(dict.fromkeys(ids))[:MAX_PLAN_STARS]
    if ids and index is not None:
        known = set(index.stars_matching({"star_ids": ids, "excluded_planets": list(excluded)}))
        ids = [s for s in ids if s in known]
    elif index is None:
        ids = []
    plan.star_ids = ids
    return plan


def _week_info(today):
    week_start = today - timedelta(days=today.weekday())
    last_week_start = week_start - timedelta(days=7)
    month_start = today.replace(day=1)
    last_month_end = month_start - timedelta(days=1)
    return {
        "today": today.isoformat(),
        "weekday": WEEKDAYS[today.weekday()] + "요일",
        "week_start": week_start.isoformat(),
        "last_week_start": last_week_start.isoformat(),
        "last_week_end": (week_start - timedelta(days=1)).isoformat(),
        "month_start": month_start.isoformat(),
        "last_month_start": last_month_end.replace(day=1).isoformat(),
        "last_month_end": last_month_end.isoformat(),
    }


def _context_text(req):
    parts = []
    if req.context.get("planet_id"):
        name = req.context.get("planet_name") or ""
        parts.append(f"열린 행성 {req.context['planet_id']}" + (f"({name})" if name else ""))
    if req.context.get("star_id"):
        parts.append(f"열린 별 {req.context['star_id']}")
    return ", ".join(parts) or "없음"


def plan_messages(req):
    excluded = set(req.excluded_planets)
    planets = "\n".join(f"{pid}: {name}" for pid, name in req.planets if pid not in excluded) or "(없음)"
    history = "\n".join(f"{'사용자' if r == 'user' else '챗봇'}: {c[:500]}" for r, c in req.history) or "(없음)"
    system = prompts.PLAN_SYSTEM.format(**_week_info(req.today), planets=planets, context=_context_text(req))
    return [SystemMessage(content=system), HumanMessage(content=prompts.PLAN_USER.format(history=history, question=req.question))]


def plan_question(chat, req, index=None):
    """모델에게 JSON 계획을 받아 검사한다. 모델 호출 실패는 ModelError, 파싱 실패는 ask."""
    raw = _invoke(chat, plan_messages(req))
    return build_plan(parse_plan_json(raw), req, index)


# ---------- 모델 호출 ----------


def _log(message):
    print(f"rag answer: {message}", file=sys.stderr, flush=True)


def _content(msg):
    content = getattr(msg, "content", msg)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p if isinstance(p, str) else str(p.get("text", "")) for p in content if isinstance(p, (str, dict)))
    return ""


def _invoke(chat, messages):
    try:
        return _content(chat.invoke(messages))
    except Exception as err:  # noqa: BLE001 — OpenAI 오류 등. 내용은 남기지 않는다.
        raise ModelError(type(err).__name__) from err


def _stream(chat, messages):
    """모델 글 조각을 흘려 낸다. 받는 쪽이 멈추면(close) 모델 스트림도 닫는다."""
    try:
        it = iter(chat.stream(messages))
    except Exception as err:  # noqa: BLE001
        raise ModelError(type(err).__name__) from err
    try:
        while True:
            try:
                chunk = next(it)
            except StopIteration:
                return
            except Exception as err:  # noqa: BLE001
                raise ModelError(type(err).__name__) from err
            text = _content(chunk)
            if text:
                yield text
    finally:
        close = getattr(it, "close", None)
        if close is not None:
            close()


# ---------- "사용한 조각" 줄 떼어 내기 ----------

_DECOR = r"[ \t*_`>#\-]"
_MARKER = re.compile(_DECOR + r"*사\s*용\s*한\s*조\s*각")
_MARKER_LINE = re.compile(_DECOR + r"*사\s*용\s*한\s*조\s*각[ \t*_`]*[:：]?(?P<rest>[^\n]*)")
_MARKER_KEY = "사용한조각"
_TAIL_WINDOW = 16


def _could_start_marker(s):
    key = re.sub(r"[\s*_`>#\-]", "", s)
    return _MARKER_KEY.startswith(key)


class UsedLineFilter:
    """흘러오는 답에서 마지막 줄 "사용한 조각: …" 이 될 수 있는 글은 붙잡아 둔다.

    feed() 는 지금 내보내도 되는 글을 돌려준다. 마커가 한 번 보이면 그 뒤는 끝까지 붙잡는다.
    줄 끝(꼬리)이 마커의 앞부분일 수 있으면 그 자리부터 붙잡는다. 끝의 공백 · 줄바꿈도 붙잡는다.
    """

    def __init__(self):
        self.text = ""
        self.sent = 0
        self.hold_at = None

    def feed(self, piece):
        self.text += piece
        text = self.text
        if self.hold_at is None:
            m = _MARKER.search(text, self.sent)
            if m:
                self.hold_at = m.start()
        if self.hold_at is not None:
            end = self.hold_at
        else:
            end = len(text)
            line_start = text.rfind("\n") + 1
            for i in range(max(self.sent, line_start, len(text) - _TAIL_WINDOW), len(text)):
                if _could_start_marker(text[i:]):
                    end = i
                    break
        while end > self.sent and text[end - 1] in " \t\r\n":
            end -= 1
        out = text[self.sent:end]
        self.sent = max(self.sent, end)
        return out

    def finish(self):
        """(화면 글, 쓴 번호 목록). 마지막 마커 줄과 그 뒤는 버린다. 마커가 없으면 번호 없음."""
        matches = list(_MARKER_LINE.finditer(self.text))
        if not matches:
            return self.text.rstrip(), []
        m = matches[-1]
        body = self.text[: m.start()].rstrip()
        nums = [int(n) for n in re.findall(r"\d+", m.group("rest"))]
        return body, nums


# ---------- 공통 ----------


def _ev_token(text):
    return {"type": "token", "text": text}


def _ev_sources(stars):
    return {"type": "sources", "stars": stars}


def _ev_done(not_found=False):
    return {"type": "done", "not_found": bool(not_found)}


def _ev_error(code, message=FAILED):
    return {"type": "error", "code": code, "message": message}


def _not_found():
    yield _ev_token(NOT_FOUND)
    yield _ev_sources([])
    yield _ev_done(True)


def _local_date(iso, req):
    if not isinstance(iso, str) or not iso.strip():
        return ""
    s = iso.strip()
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(req.tz).date().isoformat()


def _source(doc):
    md = doc.metadata
    return {"star_id": md.get("star_id"), "attachment_id": md.get("attachment_id"), "file_name": md.get("file_name")}


def _star_titles(index, star_ids):
    titles = {}
    for doc in index.chunks_for(star_ids):
        sid = doc.metadata.get("star_id")
        if sid not in titles and doc.metadata.get("source") == "title":
            first = doc.page_content.split("\n", 1)[0].strip()
            titles[sid] = first if first and not first.startswith("행성:") else "(제목 없음)"
    return titles


def _header(doc, titles, req):
    md = doc.metadata
    parts = [f"별: {titles.get(md.get('star_id')) or '(제목 없음)'}"]
    day = _local_date(md.get("created_at"), req)
    if day:
        parts.append(day)
    if md.get("file_name"):
        parts.append(f"파일: {md['file_name']}")
    return " · ".join(parts)


class Ctx:
    def __init__(self, req, chat, index, k, min_score):
        self.req = req
        self.chat = chat
        self.index = index
        self.k = k
        self.min_score = min_score
        self.excluded = set(req.excluded_planets)

    def allowed(self, doc):
        return doc.metadata.get("planet_id") not in self.excluded

    def search(self, query, plan):
        try:
            hits = self.index.search(query, k=self.k, star_filter=plan.star_filter(self.req))
        except ValueError:  # 필터가 틀렸다(코드 오류) → internal
            raise
        except Exception as err:  # noqa: BLE001 — 질문 임베딩(OpenAI) 실패
            raise ModelError(type(err).__name__) from err
        return [(d, s) for d, s in hits if s >= self.min_score and self.allowed(d)]


# ---------- find ----------


def run_find(plan, ctx):
    req = ctx.req
    if not plan.query and plan.has_scope():
        ids = ctx.index.stars_matching(plan.star_filter(req))
        stars = [{"star_id": s, "attachment_id": None, "file_name": None} for s in reversed(ids)][:FIND_MAX]
    else:
        stars, seen = [], set()
        for doc, _ in ctx.search(plan.query or req.question, plan):
            sid = doc.metadata.get("star_id")
            if sid in seen:
                continue
            seen.add(sid)
            stars.append(_source(doc))
            if len(stars) >= FIND_MAX:
                break
    if not stars:
        yield from _not_found()
        return
    yield _ev_sources(stars)
    yield _ev_token(f"찾은 별 {len(stars)}개예요.")
    yield _ev_done(False)


# ---------- ask ----------


def run_ask(plan, ctx):
    req = ctx.req
    hits = ctx.search(plan.query or req.question, plan)
    if not hits:
        yield from _not_found()
        return
    docs = [d for d, _ in hits]
    titles = _star_titles(ctx.index, [d.metadata.get("star_id") for d in docs])
    numbered = "\n\n".join(f"[{i}] {_header(d, titles, req)}\n{d.page_content}" for i, d in enumerate(docs, 1))
    messages = [
        SystemMessage(content=prompts.ASK_SYSTEM),
        HumanMessage(content=prompts.ASK_USER.format(chunks=numbered, question=req.question)),
    ]

    used = UsedLineFilter()
    with closing(_stream(ctx.chat, messages)) as pieces:
        for piece in pieces:
            out = used.feed(piece)
            if out:
                yield _ev_token(out)
    body, nums = used.finish()

    valid = [n for n in dict.fromkeys(nums) if 1 <= n <= len(docs)]
    stars, seen = [], set()
    for n in valid:
        doc = docs[n - 1]
        sid = doc.metadata.get("star_id")
        if sid in seen or not ctx.allowed(doc):
            continue
        seen.add(sid)
        stars.append(_source(doc))

    if not stars:
        yield {"type": "replace", "text": NOT_FOUND}
        yield _ev_sources([])
        yield _ev_done(True)
        return
    if used.sent <= len(body):
        rest = body[used.sent:]
        if rest:
            yield _ev_token(rest)
    else:
        yield {"type": "replace", "text": body}
    yield _ev_sources(stars)
    yield _ev_done(False)


# ---------- summarize ----------


def _batches(blocks, limit):
    out, cur, size = [], [], 0
    for b in blocks:
        b = b[:limit]
        if cur and size + len(b) + 2 > limit:
            out.append(cur)
            cur, size = [], 0
        cur.append(b)
        size += len(b) + 2
    if cur:
        out.append(cur)
    return out


def run_summarize(plan, ctx):
    req = ctx.req
    if plan.star_ids:
        targets = list(plan.star_ids)
    elif plan.has_scope():
        targets = ctx.index.stars_matching(plan.star_filter(req))
    else:
        targets = list(dict.fromkeys(d.metadata.get("star_id") for d, _ in ctx.search(plan.query or req.question, plan)))
    if not targets:
        yield from _not_found()
        return
    if len(targets) > SUMMARY_MAX_STARS:
        yield _ev_error("too_broad", TOO_BROAD)
        return

    docs = [d for d in ctx.index.chunks_for(targets) if ctx.allowed(d)]
    if not docs:
        yield from _not_found()
        return
    titles = _star_titles(ctx.index, targets)
    blocks = [f"[{_header(d, titles, req)}]\n{d.page_content}" for d in docs]
    total = sum(len(b) + 2 for b in blocks)

    if total <= SUMMARY_ONE_CALL:
        messages = [
            SystemMessage(content=prompts.SUMMARY_SYSTEM),
            HumanMessage(content=prompts.SUMMARY_USER.format(question=req.question, chunks="\n\n".join(blocks))),
        ]
    else:
        batches = _batches(blocks, SUMMARY_BATCH)
        partials = []
        for i, batch in enumerate(batches, 1):
            partials.append(
                _invoke(
                    ctx.chat,
                    [
                        SystemMessage(content=prompts.MAP_SYSTEM),
                        HumanMessage(
                            content=prompts.MAP_USER.format(
                                question=req.question, total=len(batches), no=i, chunks="\n\n".join(batch)
                            )
                        ),
                    ],
                )
            )
            # 묶음마다 한 번 내보낸다: 연결이 끊겼으면 여기서 GeneratorExit 로 멈춘다(다음 묶음을 부르지 않는다).
            yield {"type": "progress", "step": i, "total": len(batches)}
        joined = "\n\n".join(f"({i}) {p.strip()}" for i, p in enumerate(partials, 1))
        messages = [
            SystemMessage(content=prompts.REDUCE_SYSTEM),
            HumanMessage(content=prompts.REDUCE_USER.format(question=req.question, partials=joined)),
        ]

    with closing(_stream(ctx.chat, messages)) as pieces:
        for piece in pieces:
            yield _ev_token(piece)
    if len(targets) > SUMMARY_SOURCES:
        yield _ev_token(f"\n\n대상 별은 모두 {len(targets)}개예요. 출처에는 앞의 {SUMMARY_SOURCES}개만 보여 드려요.")
    yield _ev_sources(
        [{"star_id": s, "attachment_id": None, "file_name": None} for s in targets[:SUMMARY_SOURCES]]
    )
    yield _ev_done(False)


# ---------- chat ----------


def run_chat(plan, ctx):
    req = ctx.req
    messages = [SystemMessage(content=prompts.CHAT_SYSTEM.format(help=prompts.HELP))]
    for role, content in req.history:
        messages.append(HumanMessage(content=content) if role == "user" else AIMessage(content=content))
    messages.append(HumanMessage(content=req.question))
    with closing(_stream(ctx.chat, messages)) as pieces:
        for piece in pieces:
            yield _ev_token(piece)
    yield _ev_sources([])
    yield _ev_done(False)


RUNNERS = {"find": run_find, "ask": run_ask, "summarize": run_summarize, "chat": run_chat}


def answer_events(req, *, chat, index, k=8, min_score=0.25):
    """질문 하나의 이벤트 전부. 받는 쪽이 close() 하면 그 자리에서 멈춘다(모델을 더 부르지 않는다)."""
    try:
        plan = plan_question(chat, req, index)
        yield plan.event()
        yield from RUNNERS[plan.intent](plan, Ctx(req, chat, index, k, min_score))
    except ModelError as err:
        _log(f"model call failed ({err})")
        yield _ev_error("openai_error")
    except Exception as err:  # noqa: BLE001 — 내용은 남기지 않는다
        _log(f"internal error ({type(err).__name__})")
        yield _ev_error("internal")
