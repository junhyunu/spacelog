// 파이썬 RAG 서버를 자식 프로세스로 띄우고, 살피고, 끈다.
// 자기가 띄운 자식만 그 PID 로 끈다. 토큰은 켤 때마다 새로 만들어 환경 변수로만 넘긴다(로그에 남기지 않는다).
import { execFile as cpExecFile, spawn as cpSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRagClient } from './client.js';

export const DEFAULT_RAG_PORT = 4748;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_PY = path.join(ROOT, 'rag', 'app.py');

const HEALTH_INTERVAL_MS = 300;
const HEALTH_DEADLINE_MS = 20_000;
const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 60_000];
// 표준 입력을 닫은 뒤(파이썬이 색인을 저장하고 스스로 끝나기를) 기다리는 시간
const STDIN_GRACE_MS = 5_000;
const KILL_GRACE_MS = 3_000;
const KILL_FINAL_MS = 2_000;
// rag/app.py 의 EXIT_PORT_IN_USE 와 같다.
export const EXIT_PORT_IN_USE = 3;

function closeStdin(c) {
  try {
    c.stdin?.end();
  } catch {
    // 이미 닫혔으면 무시
  }
}

export function defaultPythonPath(platform = process.platform) {
  return platform === 'win32'
    ? path.join(ROOT, 'rag', '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, 'rag', '.venv', 'bin', 'python');
}

// 자식 출력 한 줄마다 [rag] 를 붙여 Node 콘솔로 보낸다.
function pipeLines(stream, write) {
  if (!stream) return;
  let rest = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    rest += String(chunk);
    let nl;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl).replace(/\r$/, '');
      rest = rest.slice(nl + 1);
      if (line) write(`[rag] ${line}`);
    }
  });
  stream.on('end', () => {
    if (rest) write(`[rag] ${rest}`);
    rest = '';
  });
}

// 띄우지 않은 채로 만든다. start() 로 띄운다(index.js 는 listen 이 성공한 뒤에 부른다).
export function createRag({
  dataDir,
  port = DEFAULT_RAG_PORT,
  pythonPath = defaultPythonPath(),
  env = process.env,
  spawn = cpSpawn,
  execFile = cpExecFile,
  fetch = globalThis.fetch,
  exists = fs.existsSync,
  platform = process.platform,
  log = console,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
} = {}) {
  if (!dataDir) throw new Error('createRag: dataDir is required');

  const token = crypto.randomBytes(24).toString('hex');
  const client = createRagClient({ baseUrl: `http://127.0.0.1:${port}`, token, fetch });

  let state = 'off';
  let reason = null;
  let child = null;
  let restarts = 0;
  let stopping = false;
  let timers = new Set();
  let stopWaiters = [];
  let stopPromise = null;

  function set(nextState, nextReason = null) {
    state = nextState;
    reason = nextReason;
  }

  function later(fn, ms) {
    const t = setTimer(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }

  function clearAll() {
    for (const t of timers) clearTimer(t);
    timers = new Set();
  }

  function spawnChild() {
    if (stopping) return;
    if (!exists(pythonPath)) {
      set('missing', 'not_installed');
      return;
    }
    set('starting');
    let c;
    try {
      c = spawn(pythonPath, ['-u', APP_PY], {
        cwd: ROOT,
        env: {
          ...env,
          SPACELOG_DATA: dataDir,
          SPACELOG_RAG_PORT: String(port),
          SPACELOG_RAG_TOKEN: token,
          SPACELOG_RAG_WATCH_STDIN: '1',
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      log.error(`[rag] failed to start: ${err.code ?? err.message}`);
      set('crashed', 'spawn_failed');
      scheduleRestart();
      return;
    }
    child = c;
    // 자식이 먼저 끝난 뒤 stdin 에 쓰거나 닫으면 EPIPE 가 날 수 있다. 처리하지 않으면 Node 가 죽는다.
    c.stdin?.on?.('error', () => {});
    pipeLines(c.stdout, (l) => log.log(l));
    pipeLines(c.stderr, (l) => log.error(l));
    let handled = false;
    const onGone = (code, signal, err) => {
      if (handled) return;
      handled = true;
      onExit(c, code, signal, err);
    };
    c.on('exit', (code, signal) => onGone(code, signal));
    c.on('error', (err) => onGone(null, null, err));

    // 첫 확인은 바로, 이후 0.3초마다. 20초 안에 응답이 없으면 실패로 보고 끈다.
    let ready = false;
    later(() => {
      if (child !== c || ready || stopping) return;
      log.error('[rag] no health response within 20 s');
      set('crashed', 'health_timeout');
      c.kill();
    }, HEALTH_DEADLINE_MS);
    const poll = () => {
      if (child !== c || stopping) return;
      client.health().then(
        () => {
          if (child !== c || stopping || ready) return;
          ready = true;
          restarts = 0;
          set('ready');
          log.log(`[rag] ready (pid ${c.pid})`);
        },
        (err) => {
          if (child !== c || stopping || ready || state !== 'starting') return;
          if (err?.status === 401) {
            // 토큰이 맞지 않는다 = 그 포트에 다른 서버(다른 spaceLog 의 파이썬 등)가 있다.
            log.error(`[rag] port ${port} is used by another server`);
            set('crashed', 'port_in_use');
            try {
              c.kill();
            } catch {
              // exit 가 처리한다.
            }
            return;
          }
          later(poll, HEALTH_INTERVAL_MS);
        },
      );
    };
    poll();
  }

  function onExit(c, code, signal, err) {
    if (child === c) child = null;
    if (stopping) {
      finishStop();
      return;
    }
    if (err) {
      log.error(`[rag] process error: ${err.code ?? err.message}`);
    } else {
      log.error(`[rag] exited (code ${code ?? '-'}${signal ? `, ${signal}` : ''})`);
    }
    if (!err && code === EXIT_PORT_IN_USE) {
      log.error(`[rag] port ${port} is already in use`);
      set('crashed', 'port_in_use');
    } else if (state !== 'crashed') {
      set('crashed', err ? 'spawn_failed' : 'exited');
    }
    // 포트가 막혀도 평소와 같은 간격(2 · 5 · 15 · 60초)으로만 다시 해 본다.
    scheduleRestart();
  }

  function scheduleRestart() {
    if (stopping) return;
    if (restarts >= RESTART_DELAYS_MS.length) {
      // 포트 문제라면 그 이유를 그대로 보여 준다.
      set('crashed', reason === 'port_in_use' ? 'port_in_use' : 'too_many_restarts');
      log.error('[rag] giving up after 4 restarts');
      return;
    }
    const delay = RESTART_DELAYS_MS[restarts];
    restarts += 1;
    log.error(`[rag] restarting in ${delay / 1000} s`);
    later(spawnChild, delay);
  }

  function finishStop() {
    clearAll();
    child = null;
    stopPromise = null;
    set('off');
    const waiters = stopWaiters;
    stopWaiters = [];
    for (const w of waiters) w();
  }

  function start() {
    if (child || state === 'starting' || state === 'ready') return;
    stopping = false;
    restarts = 0;
    spawnChild();
  }

  // 자식을 끝낸다.
  // 1) 표준 입력을 닫는다 → 파이썬이 색인을 저장(flush)하고 스스로 끝난다.
  // 2) 5초 안에 안 끝나면 kill(), 3) 다시 3초 뒤 Windows 는 taskkill /T /F(그 PID 만), 아니면 SIGKILL.
  // 동기 부분은 1) 뿐이다. process 'exit' 처리기(기다릴 수 없음)에서 부르면 표준 입력만 닫힌다.
  function stop() {
    const c = child;
    if (stopping && stopPromise) {
      if (c) closeStdin(c);
      return stopPromise;
    }
    stopping = true;
    clearAll();
    if (!c || c.exitCode !== null) {
      finishStop();
      return Promise.resolve();
    }
    stopPromise = new Promise((resolve) => {
      stopWaiters.push(resolve);
      closeStdin(c);
      later(() => {
        if (child !== c) return;
        try {
          c.kill();
        } catch {
          // 이미 끝났으면 exit 가 처리한다.
        }
        later(() => {
          if (child !== c) return;
          if (platform === 'win32' && c.pid) {
            // 그 자식 PID(과 그 아래)만 끝낸다.
            execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], () => {});
          } else {
            try {
              c.kill('SIGKILL');
            } catch {
              // 무시
            }
          }
          later(finishStop, KILL_FINAL_MS);
        }, KILL_GRACE_MS);
      }, STDIN_GRACE_MS);
    });
    return stopPromise;
  }

  return {
    client,
    start,
    stop,
    status: () => (reason ? { state, reason } : { state }),
    pid: () => child?.pid ?? null,
  };
}

// 만들고 바로 띄운다.
export function startRag(options) {
  const rag = createRag(options);
  rag.start();
  return rag;
}
