// Stop 훅: 화면 파일을 고쳤는데 DESIGN.md는 안 고친 채 끝내려 하면 한 번 알려 준다.
// 같은 변경 상태에 대해서는 한 번만 알린다(디자인과 무관한 변경이면 그냥 끝낼 수 있게).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UI = /^web\/(index\.html$|src\/(styles|ui|three)\/)/
const SKIP = /\.test\.js$/

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

try {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {}

  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

  // 커밋되지 않은 변경(스테이지 포함)과 새 파일
  const lines = git(['status', '--porcelain', '--untracked-files=all', '--', 'web', 'DESIGN.md'], cwd)
    .split('\n')
    .filter(Boolean)
  const paths = lines.map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''))

  if (paths.includes('DESIGN.md')) process.exit(0)

  const ui = paths.filter((p) => UI.test(p) && !SKIP.test(p)).sort()
  if (ui.length === 0) process.exit(0)

  // 같은 변경 상태에는 한 번만 알린다
  const diff = git(['diff', 'HEAD', '--', ...ui], cwd)
  const sig = createHash('sha1').update(ui.join('\n')).update(diff).digest('hex')
  const mark = join(tmpdir(), `spacelog-design-sync-${input.session_id || 'nosession'}.txt`)
  if (existsSync(mark) && readFileSync(mark, 'utf8') === sig) process.exit(0)
  writeFileSync(mark, sig)

  const shown = ui.slice(0, 8).join(', ') + (ui.length > 8 ? ` 외 ${ui.length - 8}개` : '')
  const reason =
    `화면 파일이 바뀌었는데 DESIGN.md는 그대로예요: ${shown}. ` +
    `화면에 보이는 모양 · 문구 · 동작 · 토큰이 바뀌었다면 CLAUDE.md의 "DESIGN.md를 앱과 맞춰 두기"대로 ` +
    `DESIGN.md의 해당 장과 15장 변경 이력을 고치세요. ` +
    `디자인과 상관없는 변경(리팩터링 등)이면 고치지 말고, 그렇다고 사용자에게 한 줄로 알린 뒤 끝내세요.`

  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
} catch {
  // 훅이 실패해도 작업을 막지 않는다
  process.exit(0)
}
