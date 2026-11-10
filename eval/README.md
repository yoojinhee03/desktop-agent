# eval

평가 하네스 (테스트: 평가 하네스와 레드팀).

- `scenarios/*.yaml`: 대표 시나리오 (요청, 준비 파일, 승인 규칙, 기대 승인 횟수, 결과 검증)
- `src/`: 시나리오 실행기 — VM에서만 실행 ([docs/eval-vm.md](../docs/eval-vm.md))
- 레드팀 퍼징 루프, 세션 리플레이는 이후 추가

```bash
corepack pnpm --filter eval scenarios --dry-run
corepack pnpm --filter eval test
```
