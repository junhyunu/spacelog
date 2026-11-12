import socket
import sys
import threading
import time

import pytest


def _app(make_config):
    from app import create_app

    app = create_app(make_config())
    # 실제 색인 닫기 대신 시험용 처리기만 둔다.
    app.extensions["spacelog"]["shutdown"] = []
    return app


def test_shutdown_hooks_run_once_when_triggered_twice(make_config):
    from app import run_shutdown_hooks

    app = _app(make_config)
    calls = []
    started = threading.Event()

    def slow_hook():
        started.set()
        time.sleep(0.2)
        calls.append(1)

    app.extensions["spacelog"]["shutdown"].append(slow_hook)

    results = []
    threads = [threading.Thread(target=lambda: results.append(run_shutdown_hooks(app))) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)

    assert calls == [1]
    # 두 번째 호출도 첫 실행이 끝날 때까지 기다렸다(먼저 돌아가 os._exit 하지 않는다).
    assert results == [True, True]
    assert run_shutdown_hooks(app) is True
    assert calls == [1]


def test_shutdown_hooks_respect_time_limit(make_config):
    from app import run_shutdown_hooks

    app = _app(make_config)
    release = threading.Event()
    app.extensions["spacelog"]["shutdown"].append(lambda: release.wait(10))

    t0 = time.monotonic()
    assert run_shutdown_hooks(app, timeout=0.3) is False
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0
    # 다시 불러도 같은 마감 시각을 쓰므로 바로 돌아온다.
    t0 = time.monotonic()
    assert run_shutdown_hooks(app, timeout=10) is False
    assert time.monotonic() - t0 < 0.5
    release.set()


def test_shutdown_hook_error_does_not_stop_others(make_config):
    from app import run_shutdown_hooks

    app = _app(make_config)
    calls = []

    def boom():
        raise ValueError("x")

    app.extensions["spacelog"]["shutdown"] += [boom, lambda: calls.append("ok")]
    assert run_shutdown_hooks(app) is True
    assert calls == ["ok"]


@pytest.mark.skipif(sys.platform != "win32", reason="SO_REUSEADDR 로 같은 포트를 함께 잡는 문제는 Windows 의 것")
def test_second_bind_on_same_port_fails_on_windows(make_config):
    from app import PortInUse, make_rag_server

    app = _app(make_config)
    server = make_rag_server("127.0.0.1", 0, app)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # 우리 서버를 하나 더: PortInUse
        with pytest.raises(PortInUse):
            make_rag_server("127.0.0.1", port, app)

        # SO_REUSEADDR 를 켠 다른 프로그램(기본 werkzeug 처럼)도 못 잡는다.
        other = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            other.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            with pytest.raises(OSError):
                other.bind(("127.0.0.1", port))
        finally:
            other.close()

        # werkzeug 의 make_server 도 실패한다(bind 실패를 sys.exit 로 바꾸므로 SystemExit).
        from werkzeug.serving import make_server

        with pytest.raises((OSError, SystemExit)):
            make_server("127.0.0.1", port, app, threaded=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


def test_main_exits_with_port_in_use_code(make_config, monkeypatch):
    import app as app_module

    def taken(*_args, **_kwargs):
        raise app_module.PortInUse("taken")

    monkeypatch.setattr(app_module, "load_config", lambda: make_config())
    monkeypatch.setattr(app_module, "make_rag_server", taken)
    with pytest.raises(SystemExit) as exc:
        app_module.main()
    assert exc.value.code == app_module.EXIT_PORT_IN_USE == 3
