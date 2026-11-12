import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRagClient, RagError } from '../rag/client.js';
import { createRag, startRag } from '../rag/process.js';
import { cleanup, makeApp } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };

// 가짜 자식 프로세스. kill() 하면 (autoExit 이면) 곧 exit 를 낸다.
// 표준 입력이 닫히면 (exitOnStdinEnd 이면) 파이썬처럼 스스로 exit(0) 한다.
// events 에 'stdin' · 'kill' 순서를 남긴다.
function fakeSpawn({ autoExit = true, exitOnStdinEnd = true } = {}) {
  const children = [];
  const spawn = vi.fn((cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 1000 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.events = [];
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = vi.fn((...a) => {
      child.events.push('stdin');
      if (exitOnStdinEnd) queueMicrotask(() => child.exit(0));
      return end(...a);
    });
    child.exitCode = null;
    child.cmd = cmd;
    child.args = args;
    child.opts = opts;
    child.kill = vi.fn(() => {
      child.events.push('kill');
      if (autoExit) queueMicrotask(() => child.exit(null, 'SIGTERM'));
      return true;
    });
    child.exit = (code, signal = null) => {
      if (child.exitCode !== null) return;
      child.exitCode = code ?? 1;
      child.emit('exit', code, signal);
    };
    children.push(child);
    return child;
  });
  return { spawn, children };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// n 번째(1부터) 호출부터 성공하는 health fetch
function healthAfter(n, body = { ok: true, key: true, model: 'm', embed_model: 'e', fake: false }) {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls < n) throw new TypeError('fetch failed');
    return json(200, body);
  });
}

const quietLog = { log: () => {}, error: () => {} };

function base(extra = {}) {
  return {
    dataDir: 'C:/tmp/data',
    port: 4999,
    pythonPath: 'C:/fake/python.exe',
    exists: () => true,
    log: quietLog,
    ...extra,
  };
}

describe('startRag', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('missing interpreter → missing / not_installed, no spawn', async () => {
    const { spawn } = fakeSpawn();
    const rag = startRag(base({ spawn, exists: () => false, fetch: vi.fn() }));
    expect(rag.status()).toEqual({ state: 'missing', reason: 'not_installed' });
    expect(spawn).not.toHaveBeenCalled();
    await rag.stop();
  });

  test('spawns app.py with data dir, port and a fresh token', async () => {
    const { spawn, children } = fakeSpawn();
    const rag = startRag(base({ spawn, fetch: healthAfter(1), env: { PATH: 'x' } }));
    expect(spawn).toHaveBeenCalledTimes(1);
    const child = children[0];
    expect(child.cmd).toBe('C:/fake/python.exe');
    expect(child.args.at(-1)).toMatch(/rag[\\/]app\.py$/);
    expect(child.opts.env.SPACELOG_DATA).toBe('C:/tmp/data');
    expect(child.opts.env.SPACELOG_RAG_PORT).toBe('4999');
    expect(child.opts.env.SPACELOG_RAG_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(child.opts.env.PATH).toBe('x');
    expect(child.opts.env.SPACELOG_RAG_WATCH_STDIN).toBe('1');
    expect(rag.status().state).toBe('starting');

    const other = startRag(base({ spawn, fetch: healthAfter(1) }));
    expect(children[1].opts.env.SPACELOG_RAG_TOKEN).not.toBe(child.opts.env.SPACELOG_RAG_TOKEN);
    await rag.stop();
    await other.stop();
  });

  test('health succeeds on the 3rd try → ready, sends the token', async () => {
    const { spawn, children } = fakeSpawn();
    const fetch = healthAfter(3);
    const rag = startRag(base({ spawn, fetch }));
    await vi.advanceTimersByTimeAsync(0);
    expect(rag.status().state).toBe('starting');
    await vi.advanceTimersByTimeAsync(300);
    expect(rag.status().state).toBe('starting');
    await vi.advanceTimersByTimeAsync(300);
    expect(rag.status()).toEqual({ state: 'ready' });
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4999/health');
    expect(init.headers['X-Spacelog-Token']).toBe(children[0].opts.env.SPACELOG_RAG_TOKEN);
    await rag.stop();
  });

  test('no health within 20 s → crashed, child killed', async () => {
    const { spawn, children } = fakeSpawn();
    const rag = startRag(base({ spawn, fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) }));
    await vi.advanceTimersByTimeAsync(20_500);
    expect(children[0].kill).toHaveBeenCalled();
    expect(rag.status().state).toBe('crashed');
    await rag.stop();
  });

  test('child exits → crashed → restarted after 2 s, then 5 s; counter resets after ready', async () => {
    const { spawn, children } = fakeSpawn();
    let healthy = true;
    const fetch = vi.fn(async () => {
      if (!healthy) throw new TypeError('fetch failed');
      return json(200, { ok: true, key: false });
    });
    const rag = startRag(base({ spawn, fetch }));
    await vi.advanceTimersByTimeAsync(0);
    expect(rag.status().state).toBe('ready');

    healthy = false;
    children[0].exit(1);
    expect(rag.status().state).toBe('crashed');
    await vi.advanceTimersByTimeAsync(1_900);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(rag.status().state).toBe('starting');

    // 뜨자마자 다시 죽으면 다음 간격은 5초
    children[1].exit(1);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(spawn).toHaveBeenCalledTimes(3);

    // 이번엔 ready 가 되면 간격이 처음(2초)으로 돌아간다
    healthy = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(rag.status().state).toBe('ready');
    children[2].exit(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawn).toHaveBeenCalledTimes(4);
    await rag.stop();
  });

  test('gives up after 4 restarts', async () => {
    const { spawn, children } = fakeSpawn();
    const rag = startRag(base({ spawn, fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) }));
    for (const wait of [2_000, 5_000, 15_000, 60_000]) {
      children.at(-1).exit(1);
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(spawn).toHaveBeenCalledTimes(5);
    children.at(-1).exit(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(rag.status()).toEqual({ state: 'crashed', reason: 'too_many_restarts' });
    await rag.stop();
  });

  test('stop() closes stdin so python flushes and exits by itself; no kill, no restart, state off', async () => {
    const { spawn, children } = fakeSpawn();
    const rag = startRag(base({ spawn, fetch: healthAfter(1) }));
    await vi.advanceTimersByTimeAsync(0);
    await rag.stop();
    expect(children[0].stdin.end).toHaveBeenCalledTimes(1);
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(rag.status()).toEqual({ state: 'off' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('stop() closes stdin before killing: kill after 5 s, taskkill for that pid only 3 s later', async () => {
    const { spawn, children } = fakeSpawn({ autoExit: false, exitOnStdinEnd: false });
    const execFile = vi.fn((cmd, args, cb) => {
      children[0].exit(1);
      cb?.(null);
    });
    const rag = startRag(base({ spawn, execFile, platform: 'win32', fetch: healthAfter(1) }));
    await vi.advanceTimersByTimeAsync(0);
    const done = rag.stop();
    // 동기 부분에서는 표준 입력만 닫는다(process 'exit' 처리기에서 부를 때와 같다).
    expect(children[0].events).toEqual(['stdin']);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(children[0].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(children[0].events).toEqual(['stdin', 'kill']);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(execFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/pid', String(children[0].pid), '/T', '/F'], expect.any(Function));
    await done;
    expect(rag.status()).toEqual({ state: 'off' });
  });

  test('stop() twice returns the same wait and does not restart the kill timers', async () => {
    const { spawn, children } = fakeSpawn({ autoExit: true, exitOnStdinEnd: false });
    const rag = startRag(base({ spawn, fetch: healthAfter(1) }));
    await vi.advanceTimersByTimeAsync(0);
    const first = rag.stop();
    await vi.advanceTimersByTimeAsync(4_000);
    const second = rag.stop();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    await first;
    expect(rag.status()).toEqual({ state: 'off' });
  });

  test('exit code 3 → crashed / port_in_use, retried only at the normal backoff', async () => {
    const { spawn, children } = fakeSpawn();
    const rag = startRag(base({ spawn, fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) }));
    children[0].exit(3);
    expect(rag.status()).toEqual({ state: 'crashed', reason: 'port_in_use' });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(rag.status()).toEqual({ state: 'crashed', reason: 'port_in_use' });
    await vi.advanceTimersByTimeAsync(100);
    expect(spawn).toHaveBeenCalledTimes(2);

    // 계속 막혀 있으면 포기해도 이유는 port_in_use
    for (const wait of [5_000, 15_000, 60_000]) {
      children.at(-1).exit(3);
      await vi.advanceTimersByTimeAsync(wait);
    }
    children.at(-1).exit(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(rag.status()).toEqual({ state: 'crashed', reason: 'port_in_use' });
    await rag.stop();
  });

  test('401 from /health while starting → crashed / port_in_use, child killed, no fast polling', async () => {
    const { spawn, children } = fakeSpawn();
    const fetch = vi.fn(async () => json(401, { error: 'unauthorized' }));
    const rag = startRag(base({ spawn, fetch }));
    await vi.advanceTimersByTimeAsync(0);
    expect(rag.status()).toEqual({ state: 'crashed', reason: 'port_in_use' });
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(spawn).toHaveBeenCalledTimes(2);
    await rag.stop();
  });

  test('createRag does not spawn until start()', async () => {
    const { spawn } = fakeSpawn();
    const rag = createRag(base({ spawn, fetch: healthAfter(1) }));
    expect(rag.status()).toEqual({ state: 'off' });
    expect(spawn).not.toHaveBeenCalled();
    rag.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    await rag.stop();
  });

  test('child output is printed with a [rag] prefix', async () => {
    const { spawn, children } = fakeSpawn();
    const lines = [];
    const rag = startRag(base({ spawn, fetch: healthAfter(1), log: { log: (l) => lines.push(l), error: (l) => lines.push(l) } }));
    children[0].stdout.write('hello\nwor');
    children[0].stdout.write('ld\n');
    children[0].stderr.write('oops\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toEqual(expect.arrayContaining(['[rag] hello', '[rag] world', '[rag] oops']));
    await rag.stop();
  });
});

describe('createRagClient', () => {
  test('unreachable → RagError unavailable', async () => {
    const client = createRagClient({ baseUrl: 'http://x', token: 't', fetch: async () => { throw new TypeError('fetch failed'); } });
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(RagError);
    expect(err.code).toBe('unavailable');
  });

  test('non-2xx → rag_error with status; bad JSON → bad_response', async () => {
    let client = createRagClient({ baseUrl: 'http://x', token: 't', fetch: async () => json(500, { error: 'boom' }) });
    let err = await client.stats().catch((e) => e);
    expect(err.code).toBe('rag_error');
    expect(err.status).toBe(500);
    expect(err.detail).toBe('boom');

    client = createRagClient({ baseUrl: 'http://x', token: 't', fetch: async () => new Response('not json', { status: 200 }) });
    err = await client.health().catch((e) => e);
    expect(err.code).toBe('bad_response');
  });

  test('posts JSON with the token', async () => {
    const fetch = vi.fn(async () => json(200, { removed: 2 }));
    const client = createRagClient({ baseUrl: 'http://x', token: 'tok', fetch });
    expect(await client.removeStars(['a', 'b'])).toEqual({ removed: 2 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://x/remove');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Spacelog-Token']).toBe('tok');
    expect(JSON.parse(init.body)).toEqual({ star_ids: ['a', 'b'] });
  });

  test('answer() yields NDJSON events across chunk boundaries', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('{"type":"token","text":"안"}\n{"type":"tok'));
        c.enqueue(enc.encode('en","text":"녕"}\n'));
        c.enqueue(enc.encode('{"type":"done","not_found":false}'));
        c.close();
      },
    });
    const client = createRagClient({ baseUrl: 'http://x', token: 't', fetch: async () => new Response(body, { status: 200 }) });
    const events = [];
    for await (const e of client.answer({ question: 'q' })) events.push(e);
    expect(events).toEqual([
      { type: 'token', text: '안' },
      { type: 'token', text: '녕' },
      { type: 'done', not_found: false },
    ]);
  });
});

describe('GET /api/chat/status', () => {
  function fakeRag(state, health) {
    return {
      status: () => state,
      client: { health: vi.fn(health ?? (async () => ({ ok: true, key: true, model: 'm' }))) },
    };
  }

  async function status(rag) {
    const { app, dataDir } = await makeApp(rag === undefined ? {} : { rag });
    try {
      const res = await app.inject({ url: '/api/chat/status', headers: HOST });
      return { code: res.statusCode, text: res.body, body: res.json() };
    } finally {
      await app.close();
      cleanup(dataDir);
    }
  }

  test('ready → key from python health, no key value anywhere', async () => {
    const rag = fakeRag({ state: 'ready' }, async () => ({ ok: true, key: true, api_key: 'sk-leak' }));
    const r = await status(rag);
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ rag: { state: 'ready', reason: null }, key: true });
    expect(r.text).not.toContain('sk-leak');
  });

  test('missing → reason, key null, no health call', async () => {
    const rag = fakeRag({ state: 'missing', reason: 'not_installed' });
    const r = await status(rag);
    expect(r.body).toEqual({ rag: { state: 'missing', reason: 'not_installed' }, key: null });
    expect(rag.client.health).not.toHaveBeenCalled();
  });

  test('health fails while ready → key null', async () => {
    const rag = fakeRag({ state: 'ready' }, async () => { throw new RagError('unavailable'); });
    expect((await status(rag)).body).toEqual({ rag: { state: 'ready', reason: null }, key: null });
  });

  test('no rag at all → off', async () => {
    expect((await status(undefined)).body).toEqual({ rag: { state: 'off', reason: null }, key: null });
  });

  test('bad Host → 403, rag not consulted', async () => {
    const rag = fakeRag({ state: 'ready' });
    const { app, dataDir } = await makeApp({ rag });
    try {
      const res = await app.inject({ url: '/api/chat/status', headers: { host: 'evil.example:4747' } });
      expect(res.statusCode).toBe(403);
      expect(rag.client.health).not.toHaveBeenCalled();
    } finally {
      await app.close();
      cleanup(dataDir);
    }
  });
});
