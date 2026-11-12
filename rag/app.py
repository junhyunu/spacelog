"""spaceLog RAG 서버(Flask). Node 가 자식 프로세스로 띄우고, 127.0.0.1 에서만 연다."""

import hmac
import json
import socket
import sys
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request, stream_with_context
from langchain_core.embeddings import Embeddings
from werkzeug.serving import ThreadedWSGIServer

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from answer import BadRequest, answer_events, parse_request  # noqa: E402
from config import load_config  # noqa: E402
from index import BadStar, StarIndex  # noqa: E402
from models import get_chat, get_embeddings  # noqa: E402

TOKEN_HEADER = "X-Spacelog-Token"


def create_app(cfg, *, embeddings=None, chat=None):
    """embeddings · chat 은 테스트가 가짜를 직접 넣을 때 쓴다. 없으면 cfg 로 만든다(처음 쓸 때)."""
    app = Flask(__name__)
    app.config["RAG"] = cfg
    app.extensions["spacelog"] = {"embeddings": embeddings, "chat": chat, "shutdown": []}
    expected = cfg.token.encode("utf-8")

    @app.before_request
    def check_token():
        given = request.headers.get(TOKEN_HEADER, "").encode("utf-8")
        if not hmac.compare_digest(given, expected):
            return jsonify(error="unauthorized"), 401
        return None

    @app.get("/health")
    def health():
        return jsonify(
            ok=True,
            key=cfg.key_present,
            model=cfg.model,
            embed_model=cfg.embed_model,
            fake=cfg.fake,
        )

    register_index_routes(app)
    register_answer_routes(app)
    app.extensions["spacelog"]["shutdown"].append(lambda: close_index(app))
    return app


# ---------- 색인 ----------

# 별 하나의 요청 본문(경로 · 글)은 작다. 이보다 크면 413.
MAX_BODY_BYTES = 8 * 1024 * 1024


class KeyMissingError(Exception):
    pass


class _NoKeyEmbeddings(Embeddings):
    """키가 없을 때 쓰는 자리 표시. 지우기 · 통계는 되고, 임베딩이 필요하면 KeyMissingError."""

    def embed_documents(self, texts):
        raise KeyMissingError

    def embed_query(self, text):
        raise KeyMissingError


def app_index(app):
    """StarIndex 를 처음 쓸 때 만든다(<data_dir>/rag/index.json 을 불러온다)."""
    ext = app.extensions["spacelog"]
    with ext["index_lock"]:
        if ext.get("index") is None:
            cfg = app.config["RAG"]
            if ext["embeddings"] is None and not cfg.fake and not cfg.key_present:
                embeddings = _NoKeyEmbeddings()
            else:
                embeddings = app_embeddings(app)
            ext["index"] = StarIndex(cfg.data_dir, embeddings)
        return ext["index"]


def close_index(app):
    index = app.extensions["spacelog"].get("index")
    if index is not None:
        index.close()


def register_index_routes(app):
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES
    app.extensions["spacelog"]["index_lock"] = threading.Lock()

    def fail(status, code, err=None):
        if err is not None:
            # 예외 종류만 남긴다(메시지에 글이나 경로가 들어 있을 수 있다).
            print(f"rag {request.path} failed: {code} ({type(err).__name__})", file=sys.stderr, flush=True)
        return jsonify(error=code), status

    def body():
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else None

    @app.errorhandler(413)
    def too_large(_err):
        return jsonify(error="too_large"), 413

    @app.post("/index")
    def index_star():
        star = body()
        if star is None:
            return fail(400, "bad_request")
        try:
            index = app_index(app)
            return jsonify(index.upsert(star))
        except BadStar:
            return fail(400, "bad_request")
        except KeyMissingError:
            return fail(503, "key_missing")
        except OSError as err:
            return fail(500, "storage_error", err)
        except Exception as err:  # noqa: BLE001 — OpenAI 오류 등
            return fail(502, "embed_failed", err)

    @app.post("/remove")
    def remove_stars():
        data = body()
        ids = data.get("star_ids") if data else None
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            return fail(400, "bad_request")
        try:
            return jsonify(removed=app_index(app).remove(ids))
        except OSError as err:
            return fail(500, "storage_error", err)

    @app.post("/reset")
    def reset_index():
        try:
            app_index(app).reset()
            return jsonify(ok=True)
        except OSError as err:
            return fail(500, "storage_error", err)

    @app.get("/stats")
    def stats():
        return jsonify(app_index(app).stats())

    @app.post("/flush")
    def flush():
        try:
            return jsonify(ok=True, saved=app_index(app).flush())
        except OSError as err:
            return fail(500, "storage_error", err)


# ---------- 답하기 ----------


def _ndjson(event):
    return json.dumps(event, ensure_ascii=False) + "\n"


def register_answer_routes(app):
    """POST /answer → application/x-ndjson. 이벤트 모양은 answer.py 맨 위 설명."""

    @app.post("/answer")
    def answer_route():
        try:
            req = parse_request(request.get_json(silent=True))
        except BadRequest as err:
            return jsonify(error="bad_request", field=err.field), 400

        cfg = app.config["RAG"]
        ext = app.extensions["spacelog"]

        def events():
            if ext["chat"] is None and not cfg.fake and not cfg.key_present:
                yield _ndjson({"type": "error", "code": "key_missing", "message": "OpenAI 키가 없어요"})
                return
            try:
                chat = app_chat(app)
                index = app_index(app)
            except Exception as err:  # noqa: BLE001
                print(f"rag /answer setup failed ({type(err).__name__})", file=sys.stderr, flush=True)
                yield _ndjson({"type": "error", "code": "internal", "message": "답을 만들지 못했어요"})
                return
            for event in answer_events(req, chat=chat, index=index, k=cfg.search_k, min_score=cfg.min_score, max_batches=cfg.sum_max_batches):
                yield _ndjson(event)

        return Response(
            stream_with_context(events()),
            mimetype="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )


def app_embeddings(app):
    ext = app.extensions["spacelog"]
    if ext["embeddings"] is None:
        ext["embeddings"] = get_embeddings(app.config["RAG"])
    return ext["embeddings"]


def app_chat(app):
    ext = app.extensions["spacelog"]
    if ext["chat"] is None:
        ext["chat"] = get_chat(app.config["RAG"])
    return ext["chat"]


# 끝내기 처리(색인 flush 등)에 쓰는 시간의 상한. 멈춘 flush 가 종료를 막지 못하게 한다.
SHUTDOWN_TIMEOUT_S = 4.0
# 신호 처리기 안에서 다시 불려도(같은 스레드) 막히지 않도록 RLock.
_shutdown_lock = threading.RLock()


def _run_hooks(hooks):
    for hook in hooks:
        try:
            hook()
        except Exception as err:  # noqa: BLE001 — 끝내는 중 오류는 기록만
            print(f"shutdown hook failed: {type(err).__name__}", file=sys.stderr, flush=True)


def run_shutdown_hooks(app, timeout=SHUTDOWN_TIMEOUT_S):
    """프로세스가 끝나기 전에 부른다(색인 flush 가 여기에 붙는다).

    SIGINT 와 표준 입력 EOF 가 함께 와도 처리기는 한 번만 돈다. 두 번째 호출은 첫 실행이 끝나기를
    (같은 마감 시각까지) 기다린다. 마감을 넘기면 기다리기를 그만두고 False 를 돌려준다.
    """
    ext = app.extensions["spacelog"]
    with _shutdown_lock:
        worker = ext.get("shutdown_worker")
        if worker is None:
            hooks = list(ext.setdefault("shutdown", []))
            worker = threading.Thread(target=_run_hooks, args=(hooks,), name="shutdown-hooks", daemon=True)
            ext["shutdown_worker"] = worker
            ext["shutdown_deadline"] = time.monotonic() + timeout
            worker.start()
        deadline = ext["shutdown_deadline"]
    worker.join(max(0.0, deadline - time.monotonic()))
    if worker.is_alive():
        print("shutdown hooks timed out", file=sys.stderr, flush=True)
        return False
    return True


# ---------- 서버 ----------

# 포트를 이미 누가 쓰고 있을 때의 종료 코드. Node(process.js) 가 이 값을 port_in_use 로 읽는다.
EXIT_PORT_IN_USE = 3


class PortInUse(RuntimeError):
    """포트를 잡지 못했다. OSError 가 아니어야 werkzeug 가 가로채 sys.exit(1) 하지 않는다."""


class ExclusiveWSGIServer(ThreadedWSGIServer):
    """Windows 에서는 SO_REUSEADDR 가 남의 포트까지 함께 잡게 해 준다. 끄고 SO_EXCLUSIVEADDRUSE 를 켠다."""

    allow_reuse_address = sys.platform != "win32"

    def server_bind(self):
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            super().server_bind()
        except OSError as err:
            raise PortInUse(f"{type(err).__name__} errno={err.errno}") from err


def make_rag_server(host, port, app):
    """요청마다 스레드를 쓰는 werkzeug 서버. 같은 포트를 두 번 잡으면 PortInUse."""
    return ExclusiveWSGIServer(host, port, app)


def _exit_when_parent_goes(app):
    """Node 가 띄웠을 때: 표준 입력이 닫히면(Node 가 끄거나 죽으면) 색인을 저장하고 끝낸다. 고아 프로세스를 남기지 않는다."""
    import os

    def watch():
        try:
            while sys.stdin.buffer.read(1024):
                pass
        except Exception:  # noqa: BLE001
            pass
        run_shutdown_hooks(app)
        os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def main():
    import logging
    import os
    import signal

    config = load_config()
    app = create_app(config)
    # 요청마다 찍히는 접근 로그는 끈다(경고 이상만).
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    def on_signal(signum, _frame):
        run_shutdown_hooks(app)
        os._exit(0)

    try:
        server = make_rag_server("127.0.0.1", config.port, app)
    except PortInUse as err:
        print(f"spaceLog rag: port {config.port} is already in use ({err})", file=sys.stderr, flush=True)
        sys.exit(EXIT_PORT_IN_USE)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, on_signal)
    if os.environ.get("SPACELOG_RAG_WATCH_STDIN") == "1":
        _exit_when_parent_goes(app)

    print(
        f"spaceLog rag  http://127.0.0.1:{config.port}  key={'yes' if config.key_present else 'no'}"
        f"  fake={'yes' if config.fake else 'no'}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
