// 네트워크 규칙: curl·wget 업로드/다운로드, scp·rsync·sftp 전송 방향
import type { Cmd, Word } from "../../parse/model.ts";
import { staticArgs } from "../../parse/model.ts";
import { judgePath, judgeWordPaths } from "../path-judge.ts";
import { judgeScript } from "../script.ts";
import { addEngine, type CmdInfo, type JudgeCtx, mergeInfo, nested } from "../state.ts";
import { type HandlerFn, syntheticWord } from "./types.ts";

interface Opt {
  name: string;
  value: Word | null;
}

/** "--opt=값", "--opt 값", "-o값", "-o 값" 형태를 펼친다 */
function options(args: Word[], withValue: Set<string>): Opt[] {
  const out: Opt[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const v = w?.value;
    if (!w || v === null || v === undefined || !v.startsWith("-")) continue;
    const eq = v.indexOf("=");
    if (v.startsWith("--") && eq > 0) {
      out.push({ name: v.slice(0, eq), value: syntheticWord(v.slice(eq + 1), w) });
    } else if (withValue.has(v)) {
      out.push({ name: v, value: args[++i] ?? null });
    } else if (!v.startsWith("--") && v.length > 2 && withValue.has(v.slice(0, 2))) {
      out.push({ name: v.slice(0, 2), value: syntheticWord(v.slice(2), w) });
    } else out.push({ name: v, value: null });
  }
  return out;
}

// ---------- curl ----------

const CURL_DATA = new Set([
  "-d",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-urlencode",
  "--json",
]);
const CURL_VALUE = new Set([
  ...CURL_DATA,
  ...["-o", "--output", "-T", "--upload-file", "-F", "--form", "--form-string", "--data-raw"],
  ...["-H", "--header", "-X", "--request", "-u", "--user", "-A", "--user-agent", "-e", "--referer"],
  ...[
    "-b",
    "--cookie",
    "-c",
    "--cookie-jar",
    "-K",
    "--config",
    "-w",
    "--write-out",
    "-m",
    "--max-time",
  ],
  ...[
    "--connect-timeout",
    "-x",
    "--proxy",
    "--url",
    "-E",
    "--cert",
    "--key",
    "--cacert",
    "-r",
    "--range",
  ],
  ...[
    "--output-dir",
    "-D",
    "--dump-header",
    "--trace",
    "--trace-ascii",
    "--resolve",
    "--retry",
    "--netrc-file",
  ],
]);

interface Upload {
  files: Word[];
  stdin: boolean;
  dynamic: boolean;
}

export const curlHandler: HandlerFn = (jc, { cmd, args, info }) => {
  const up: Upload = { files: [], stdin: false, dynamic: false };
  for (const o of options(args, CURL_VALUE)) curlOption(jc, o, up, info);
  finishUpload(jc, cmd, up, info, "curl");
};

function curlOption(jc: JudgeCtx, o: Opt, up: Upload, info: CmdInfo): void {
  const v = o.value?.value ?? null;
  if (
    o.value &&
    v === null &&
    (CURL_DATA.has(o.name) || o.name === "--data-raw" || o.name === "-F")
  ) {
    up.dynamic = true;
    return;
  }
  if (o.name === "-T" || o.name === "--upload-file") addFile(up, o.value, v);
  else if (o.name === "-F" || o.name === "--form")
    addFile(up, o.value, v?.match(/=[@<]([^;]+)/)?.[1] ?? null);
  else if (CURL_DATA.has(o.name))
    addFile(up, o.value, v?.match(/^(?:[^@=]*@|@)(.+)$/)?.[1] ?? null);
  else if (o.name === "-K" || o.name === "--config") up.dynamic = true;
  else if ((o.name === "-o" || o.name === "--output") && o.value && v !== "-") {
    for (const p of judgeWordPaths(jc, o.value, "write", false, info)) jc.remote.add(p);
  } else if (o.name === "-D" && o.value && v !== "-")
    judgeWordPaths(jc, o.value, "write", false, info);
  else if (o.name === "--netrc-file" && o.value) judgeWordPaths(jc, o.value, "read", false, info);
}

function addFile(up: Upload, w: Word | null, file: string | null): void {
  if (!w || file === null) return;
  if (file === "-" || file === ".") up.stdin = true;
  else up.files.push(syntheticWord(file, w));
}

function finishUpload(jc: JudgeCtx, cmd: Cmd, up: Upload, info: CmdInfo, tool: string): void {
  for (const f of up.files) judgeWordPaths(jc, f, "upload", false, info);
  if (up.stdin) for (const p of upstreamReads(cmd, jc)) judgePath(jc, p, "upload", false, info);
  if (up.files.length > 0 || up.stdin || up.dynamic) {
    const what = [
      ...up.files.map((f) => f.value ?? f.raw),
      ...(up.stdin ? ["표준 입력"] : []),
      ...(up.dynamic ? ["동적 데이터"] : []),
    ];
    addEngine(jc, "net.upload", `${tool} ${what.join(", ")}`);
  }
}

function upstreamReads(cmd: Cmd, jc: JudgeCtx): string[] {
  return cmd.pipeFrom.flatMap((c) => jc.infos.get(c)?.readPaths ?? []);
}

// ---------- wget ----------

const WGET_VALUE = new Set([
  "-O",
  "--output-document",
  "-o",
  "--output-file",
  "-P",
  "--directory-prefix",
  "-i",
  "--input-file",
  "--post-file",
  "--body-file",
  "--post-data",
  "--body-data",
  "--header",
  "-U",
  "--user-agent",
  "--method",
]);

export const wgetHandler: HandlerFn = (jc, { cmd, args, info }) => {
  const up: Upload = { files: [], stdin: false, dynamic: false };
  for (const o of options(args, WGET_VALUE)) {
    const v = o.value?.value ?? null;
    if (o.name === "--post-file" || o.name === "--body-file") addFile(up, o.value, v);
    else if ((o.name === "--post-data" || o.name === "--body-data") && v === null)
      up.dynamic = true;
    else if (
      ["-O", "--output-document", "-o", "--output-file", "-P", "--directory-prefix"].includes(
        o.name,
      )
    ) {
      if (!o.value || v === "-") continue;
      const paths = judgeWordPaths(jc, o.value, "write", false, info);
      if (o.name === "-O" || o.name === "--output-document")
        for (const p of paths) jc.remote.add(p);
    } else if ((o.name === "-i" || o.name === "--input-file") && o.value)
      judgeWordPaths(jc, o.value, "read", false, info);
  }
  finishUpload(jc, cmd, up, info, "wget");
};

// ---------- ssh ----------

const SSH_VALUE = new Set([
  "-p",
  "-i",
  "-l",
  "-o",
  "-F",
  "-J",
  "-L",
  "-R",
  "-D",
  "-b",
  "-c",
  "-e",
  "-E",
  "-I",
  "-m",
  "-O",
  "-Q",
  "-S",
  "-W",
  "-w",
  "-B",
]);

/** ssh host 명령… 의 원격 명령도 셸 문자열로 판정한다 (localhost 등 같은 PC일 수 있다) */
export const sshHandler: HandlerFn = (jc, { args, info }) => {
  let i = 0;
  while (i < args.length) {
    const v = args[i]?.value;
    if (v && SSH_VALUE.has(v)) i += 2;
    else if (v?.startsWith("-")) i += 1;
    else break;
  }
  const remote = args.slice(i + 1);
  if (remote.length === 0) return;
  const values = staticArgs(remote);
  if (values === null) {
    addEngine(jc, "cmd.shell.dynamic", remote.map((w) => w.raw).join(" "));
    return;
  }
  mergeInfo(info, judgeScript(values.join(" "), nested(jc)));
};

// ---------- scp, rsync, sftp ----------

const TRANSFER_VALUE = new Set([
  "-i",
  "-F",
  "-P",
  "-o",
  "-c",
  "-l",
  "-S",
  "-J",
  "-e",
  "--rsh",
  "--exclude",
  "--include",
  "--filter",
  "-f",
  "--files-from",
  "--password-file",
  "--port",
  "--log-file",
  "--backup-dir",
  "--link-dest",
  "--compare-dest",
  "--temp-dir",
  "-T",
  "--chmod",
  "--chown",
  "-B",
  "-b",
]);
const REMOTE = /^(?:[^/@:\s]+@)?[^/:\s]+:{1,2}/;

export const transferHandler: HandlerFn = (jc, { name, args, info }) => {
  const ops = transferOperands(args);
  if (name === "sftp" || ops.length < 2) {
    addEngine(jc, "net.upload", `${name} (전송 방향을 확정할 수 없음)`);
    return;
  }
  const dest = ops.at(-1) as Word;
  const sources = ops.slice(0, -1);
  const recursive = args.some((a) => a.value !== null && /^-[a-zA-Z]*[raR]/.test(a.value));
  if (isRemote(dest)) {
    for (const s of sources) judgeWordPaths(jc, s, "upload", recursive, info);
    addEngine(jc, "net.upload", `${name} → ${dest.raw}`);
  } else if (sources.some(isRemote)) {
    addEngine(jc, "net.download", `${name} ${sources.map((s) => s.raw).join(" ")}`);
    judgeWordPaths(jc, dest, "write", false, info);
  } else {
    for (const s of sources) judgeWordPaths(jc, s, "read", recursive, info);
    judgeWordPaths(jc, dest, "write", false, info);
  }
};

function transferOperands(args: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value;
    if (v && TRANSFER_VALUE.has(v)) i++;
    else if (v?.startsWith("-")) continue;
    else if (args[i]) out.push(args[i] as Word);
  }
  return out;
}

function isRemote(w: Word): boolean {
  if (w.value === null) return true; // 알 수 없는 대상은 원격일 수 있다고 본다
  if (/^[/.~]/.test(w.value)) return false;
  return REMOTE.test(w.value) || w.value.startsWith("rsync://");
}
