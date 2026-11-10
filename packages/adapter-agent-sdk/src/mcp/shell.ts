import { spawn } from "node:child_process";

export interface ShellResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * 정책 엔진 결정("셸 파서: tree-sitter-bash, 에이전트 셸은 bash로 실행")대로
 * /bin/bash --noprofile --norc -c 로 실행한다. 판정한 문법과 실행하는 셸을 일치시키고,
 * 사용자 rc 파일의 별칭·함수가 실제 명령을 가리지 못하게 한다.
 * BASH_ENV·ENV는 비대화형 bash가 실행 전에 읽는 파일이라 지운다.
 */
export function shellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { BASH_ENV: _b, ENV: _e, ...rest } = base;
  return rest;
}

function collector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      truncated ||= chunk.length > room;
      size += Math.min(chunk.length, room);
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}

function spawnBash(command: string, cwd: string) {
  return spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
    cwd,
    env: shellEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 제한 시간이 지나면 프로세스를 죽인다. timedOut()으로 죽였는지 확인한다 */
function deadline(child: ReturnType<typeof spawnBash>, ms: number) {
  let fired = false;
  const timer = setTimeout(() => {
    fired = child.kill("SIGKILL");
  }, ms);
  return { clear: () => clearTimeout(timer), timedOut: () => fired };
}

export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawnBash(command, opts.cwd);
    const out = collector(opts.maxBytes);
    const err = collector(opts.maxBytes);
    const timer = deadline(child, opts.timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      timer.clear(); // 실행 실패 시 close가 오지 않을 수 있어 타이머를 여기서도 정리한다
      reject(e);
    });
    child.on("close", (exitCode, signal) => {
      timer.clear();
      const truncated = out.truncated() || err.truncated();
      const timedOut = timer.timedOut();
      resolve({ exitCode, signal, stdout: out.text(), stderr: err.text(), truncated, timedOut });
    });
  });
}

export function formatShellResult(r: ShellResult): string {
  const parts = [`exit_code: ${r.exitCode ?? `signal ${r.signal}`}`];
  if (r.timedOut) parts.push("(시간 초과로 중단됨)");
  if (r.truncated) parts.push("(출력이 길어 잘림)");
  if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  return parts.join("\n");
}
