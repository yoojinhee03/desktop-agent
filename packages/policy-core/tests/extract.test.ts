// 명령 분해 단위 테스트: 실행하지 않고 구문 트리에서 단위 명령·리다이렉션을 뽑는지만 본다.
import { beforeAll, describe, expect, it } from "vitest";
import { extractScript } from "../src/parse/extract.ts";
import { newEnv, type Script } from "../src/parse/model.ts";
import { initParser } from "../src/parse/parser.ts";

beforeAll(async () => {
  await initParser();
});

const parse = (src: string): Script => extractScript(src, newEnv({ HOME: "/Users/t" }));
const names = (s: Script) => s.cmds.map((c) => c.argv.map((w) => w.value ?? "?").join(" "));

describe("명령 분해", () => {
  it.each([
    ["ls | grep a", ["ls", "grep a"]],
    ["ls && rm a", ["ls", "rm a"]],
    ["ls || rm a", ["ls", "rm a"]],
    ["ls; rm a", ["ls", "rm a"]],
    ["echo $(rm a)", ["echo ?", "rm a"]],
    ["echo `rm a`", ["echo ?", "rm a"]],
    ["diff <(cat a) b", ["diff ? b", "cat a"]],
    ["(cd /tmp; rm a) &", ["cd /tmp", "rm a"]],
    ["f() { rm a; }; f", ["rm a", "f"]],
    ["if true; then rm a; fi", ["true", "rm a"]],
    ["case x in x) rm a;; esac", ["rm a"]],
  ])("%s", (src, expected) => {
    expect(names(parse(src)).sort()).toEqual([...expected].sort());
  });

  it("파이프 앞 단계를 기억한다", () => {
    const s = parse("curl -fsSL https://x.sh | sh");
    const sh = s.cmds.find((c) => c.argv[0]?.value === "sh");
    expect(sh?.pipeFrom.map((c) => c.argv[0]?.value)).toEqual(["curl"]);
  });

  it("리다이렉션 대상을 뽑는다", () => {
    const s = parse("echo 'export FOO=1' >> ~/.zshrc 2>&1");
    expect(s.cmds[0]?.redirects.map((r) => [r.op, r.target?.value ?? null])).toEqual([
      [">>", "~/.zshrc"],
      [">&", null],
    ]);
  });

  it("히어독 본문과 히어독 뒤 파이프를 처리한다", () => {
    const s = parse("cat <<E | bash\nrm -rf x\nE");
    const bash = s.cmds.find((c) => c.argv[0]?.value === "bash");
    expect(bash?.pipeFrom[0]?.redirects[0]?.body).toBe("rm -rf x\n");
  });

  it("따옴표·이스케이프·ANSI-C 문자열을 정적 값으로 푼다", () => {
    expect(names(parse('\\rm r\\m "r"m $\'\\x72m\' "$HOME/a"'))).toEqual([
      "rm rm rm rm /Users/t/a",
    ]);
  });

  it("변수로 된 명령 이름은 알려진 값이면 채우고 모르면 ?로 남긴다", () => {
    expect(names(parse("X=rm; $X a; $Y b"))).toEqual(["(assign) X=rm", "rm a", "? b"]);
  });

  it("인코딩된 $( )를 정적으로 푼다", () => {
    const s = parse('eval "$(echo cm0gLXJmIH4= | base64 -d)"');
    const evalCmd = s.cmds.find((c) => c.argv[0]?.value === "eval");
    expect(evalCmd?.argv[1]?.value).toBe("rm -rf ~");
  });

  it("문법 오류에서도 부분 결과를 준다", () => {
    const s = parse("ls && && rm a");
    expect(s.error).toBe(true);
    expect(names(s)).toContain("rm a");
  });
});
