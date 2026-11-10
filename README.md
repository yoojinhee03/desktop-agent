# desktop-agent

맥/윈도우용 챗봇형 자율 에이전트. 위험한 작업만 사람 승인을 받는다. 설계·결정은 노션 허브(docs/README.md)를 기준으로 한다.

## 개발

```bash
corepack pnpm install      # corepack enable 없이 실행 (전역 설정 변경 없음)
corepack pnpm test
corepack pnpm --filter policy-core test
corepack pnpm --filter cli dev
```

에이전트 실행 확인은 `$TMPDIR/desktop-agent-sandbox`에서만 한다.
