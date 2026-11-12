import { spawn } from 'node:child_process';
import path from 'node:path';

function checkPath(absPath) {
  if (typeof absPath !== 'string' || absPath === '' || absPath.includes('\0')) {
    throw new Error('opener: invalid path');
  }
}

// Windows 는 인자 배열이 아니라 한 줄짜리 명령줄을 넘기고, explorer 는 그 줄에서 쉼표를 인자 구분으로 읽는다.
// Node 는 공백이 없는 인자를 따옴표로 감싸지 않으므로(`a,b.pdf` 가 둘로 갈린다) 직접 "..." 로 감싸고
// windowsVerbatimArguments 로 그대로 넘긴다. 셸을 거치지 않으므로 & · % · ^ · 괄호는 해석되지 않는다.
// Windows 경로에는 " 가 들어갈 수 없지만, 들어 있으면 인자가 갈라지므로 거절한다.
function windowsCommand(absPath, env, prefix) {
  checkPath(absPath);
  if (absPath.includes('"')) throw new Error('opener: invalid path');
  // 현재 폴더의 explorer.exe 가 잡히지 않도록 전체 경로로 부른다.
  const explorer = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'explorer.exe');
  return { cmd: explorer, args: [`${prefix}"${absPath}"`], options: { windowsVerbatimArguments: true } };
}

// `cmd /c start "" <path>` 대신 explorer.exe 에 경로를 넘긴다.
// cmd 는 인자 배열로 넘겨도 한 줄로 합쳐진 명령을 다시 해석해서 & · % · ^ 가 살아난다.
export function windowsOpenCommand(absPath, env = process.env) {
  return windowsCommand(absPath, env, '');
}

// explorer 는 `/select,"<경로>"` 모양만 제대로 읽는다.
export function windowsRevealCommand(absPath, env = process.env) {
  return windowsCommand(absPath, env, '/select,');
}

// OS 별로 실행할 프로그램과 인자를 정한다. 셸을 거치지 않으므로 경로 안의 & · 공백 · % 가 해석되지 않는다.
export function openerCommand(kind, absPath, platform = process.platform, env = process.env) {
  checkPath(absPath);
  if (platform === 'win32') {
    return kind === 'open' ? windowsOpenCommand(absPath, env) : windowsRevealCommand(absPath, env);
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: kind === 'open' ? [absPath] : ['-R', absPath], options: {} };
  }
  // 그 밖(리눅스 등): 파일을 골라 보여 주는 공통 방법이 없어 폴더를 연다.
  return { cmd: 'xdg-open', args: [kind === 'open' ? absPath : path.dirname(absPath)], options: {} };
}

// 띄운 프로그램을 기다리지 않는다. 실행 파일이 없을 때 나는 'error' 이벤트를 받아 두지 않으면 서버가 죽는다.
function run(kind, absPath) {
  const { cmd, args, options } = openerCommand(kind, absPath);
  const child = spawn(cmd, args, { ...options, detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
}

export const defaultOpener = {
  open(absPath) {
    run('open', absPath);
  },
  reveal(absPath) {
    run('reveal', absPath);
  },
};
