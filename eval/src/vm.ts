import { execFileSync } from "node:child_process";

export interface VmCheck {
  vm: boolean;
  detail: string;
}

/**
 * 시나리오는 실제 홈·휴지통·셸 설정을 바꾸므로 VM 안에서만 돌린다 (2026-11-10 사용자 결정).
 * macOS는 가상 머신 안에서 sysctl kern.hv_vmm_present = 1 을 돌려준다.
 * 확인할 수 없으면 VM이 아닌 것으로 본다 (실행하지 않는 쪽으로 틀린다).
 */
export function checkVirtualMachine(read: () => string = readHvVmmPresent): VmCheck {
  try {
    const value = read().trim();
    return { vm: value === "1", detail: `kern.hv_vmm_present=${value}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { vm: false, detail: `kern.hv_vmm_present 확인 실패: ${reason}` };
  }
}

function readHvVmmPresent(): string {
  return execFileSync("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8" });
}

export function notVmMessage(check: VmCheck): string {
  return (
    `이 컴퓨터는 VM이 아닙니다 (${check.detail}). 대표 시나리오는 실제 홈·휴지통·셸 설정을 바꾸므로 ` +
    "VM 안에서만 실행합니다. docs/eval-vm.md를 참고하세요. 시나리오 형식만 확인하려면 --dry-run을 쓰세요."
  );
}
