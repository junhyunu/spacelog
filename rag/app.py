"""spaceLog RAG 서버(Flask). Node 가 자식 프로세스로 띄우고, 127.0.0.1 에서만 연다."""

import hmac
import sys
from pathlib import Path

from flask import Flask, jsonify, request

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import load_config  # noqa: E402
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

    return app


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


def run_shutdown_hooks(app):
    """프로세스가 끝나기 전에 부른다(Task 2 의 색인 flush 가 여기에 붙는다)."""
    for hook in app.extensions["spacelog"].setdefault("shutdown", []):
        try:
            hook()
        except Exception as err:  # noqa: BLE001 — 끝내는 중 오류는 기록만
            print(f"shutdown hook failed: {err}", file=sys.stderr, flush=True)


def _exit_when_parent_goes(app):
    """Node 가 띄웠을 때: 표준 입력이 닫히면(Node 가 죽으면) 스스로 끝낸다. 고아 프로세스를 남기지 않는다."""
    import os
    import threading

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

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, on_signal)
    if os.environ.get("SPACELOG_RAG_WATCH_STDIN") == "1":
        _exit_when_parent_goes(app)

    print(
        f"spaceLog rag  http://127.0.0.1:{config.port}  key={'yes' if config.key_present else 'no'}"
        f"  fake={'yes' if config.fake else 'no'}",
        flush=True,
    )
    app.run(host="127.0.0.1", port=config.port, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
