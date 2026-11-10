# eval

평가 하네스 (테스트: 평가 하네스와 레드팀).

- `scenarios/*.yaml`: 대표 시나리오 (요청, 준비 파일, 승인 규칙, 기대 승인 횟수, 결과 검증)
- `src/`: 시나리오 실행기 — VM에서만 실행 ([docs/eval-vm.md](../docs/eval-vm.md))
- `src/replay/`: 정책 재생 — 감사 로그에 기록된 도구 호출을 지금(또는 후보) 규칙으로 다시 판정해 달라진 것만 보고
- 레드팀 퍼징 루프는 이후 추가

```bash
corepack pnpm --filter eval scenarios --dry-run
corepack pnpm --filter eval test
```

## 정책 재생

모델을 부르지 않고 판정만 다시 한다. 감사 로그는 읽기 전용으로 연다.

```bash
corepack pnpm --filter eval replay                       # 앱 감사 로그 (~/Library/Application Support/desktop-agent)
corepack pnpm --filter eval replay --sandbox             # 개발용 샌드박스 감사 로그
corepack pnpm --filter eval replay --rules 후보.yaml      # 규칙 YAML을 바꾸기 전에 영향 미리 보기
corepack pnpm --filter eval replay --json --fail-on-looser   # 더 느슨해진 판정이 있으면 exit 1
```

변화 종류: 같음 / 더 엄격 / **더 느슨**(회귀 신호, 차단을 풀면 결정 로그에 남긴다) / 규칙·처리 변경 / 재판정 오류.

한계:

- 판정은 지금 디스크 상태를 본다 (글로브 개수, 파일 내용). 기록 당시와 파일이 달라졌으면 그만큼 다르게 나올 수 있다.
- 감사 로그의 도구 입력은 시크릿이 가려진 상태로 저장된다. 가려진 값이 판정에 영향을 주는 경우는 정확히 재현되지 않는다.
- 작업 폴더·홈은 이 기능 이후의 기록부터 남는다. 그 전 기록은 현재 홈을 기준으로 재판정한다.
