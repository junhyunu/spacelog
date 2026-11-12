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
const KILL_GRACE_MS = 3_000;
const KILL_FINAL_MS = 2_000;

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
        () => {
          if (child !== c || stopping || ready || state !== 'starting') return;
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
    if (state !== 'crashed') set('crashed', err ? 'spawn_failed' : 'exited');
    scheduleRestart();
  }

  function scheduleRestart() {
    if (stopping) return;
    if (restarts >= RESTART_DELAYS_MS.length) {
      set('crashed', 'too_many_restarts');
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

  // 자식을 끝낸다. 동기 부분에서 바로 kill() 하므로 process 'exit' 처리기에서 기다리지 않고 불러도 된다.
  function stop() {
    stopping = true;
    clearAll();
    const c = child;
    if (!c || c.exitCode !== null) {
      finishStop();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      stopWaiters.push(resolve);
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
    });
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
