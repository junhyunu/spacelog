// 캐릭터 꾸미기(스펙 6-10). 고른 모습을 meta 표의 'character' 키에 JSON 으로 둔다.
//   GET /api/character → { kind, suit, accent, flame }   없거나 깨졌으면 기본값
//   PUT /api/character { kind, suit (0~16), accent (0~16), flame }   잘못된 값은 400 invalid_character

export const CHARACTER_KINDS = Object.freeze(['astronaut', 'robot', 'cat', 'alien', 'bear', 'human']);
export const CHARACTER_FLAMES = Object.freeze(['orange', 'blue', 'green', 'pink']);
export const CHARACTER_COLOR_MAX = 16; // 0 = 기본, 1~16 = 행성 색
export const DEFAULT_CHARACTER = Object.freeze({ kind: 'astronaut', suit: 0, accent: 0, flame: 'orange' });

const colorOk = (v) => Number.isInteger(v) && v >= 0 && v <= CHARACTER_COLOR_MAX;

/** 받은 값이 올바르면 네 칸만 담은 새 객체를, 아니면 null 을 돌려준다. */
export function parseCharacter(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { kind, suit, accent, flame } = value;
  if (typeof kind !== 'string' || !CHARACTER_KINDS.includes(kind)) return null;
  if (!colorOk(suit) || !colorOk(accent)) return null;
  if (typeof flame !== 'string' || !CHARACTER_FLAMES.includes(flame)) return null;
  return { kind, suit, accent, flame };
}

function readCharacter(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'character'").get();
  if (!row) return { ...DEFAULT_CHARACTER };
  try {
    return parseCharacter(JSON.parse(row.value)) ?? { ...DEFAULT_CHARACTER };
  } catch {
    return { ...DEFAULT_CHARACTER };
  }
}

export function registerCharacter(app) {
  const { db } = app;

  app.get('/api/character', async () => readCharacter(db));

  app.put('/api/character', async (req, reply) => {
    const look = parseCharacter(req.body);
    if (!look) return reply.code(400).send({ error: 'invalid_character' });
    db.prepare("INSERT INTO meta (key, value) VALUES ('character', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify(look),
    );
    return look;
  });
}
