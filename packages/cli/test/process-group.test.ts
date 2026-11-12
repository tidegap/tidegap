/**
 * The process-group helper: its answers, its floor on the group id, and a
 * real detached group of the test's own.
 */

import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { signalGroup } from "../src/process-group.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("signalGroup", () => {
  it("maps the kill outcome: no throw is sent, ESRCH is gone, EPERM is denied; the call targets -pgid", () => {
    const ok = vi.fn();
    expect(signalGroup(4242, "SIGTERM", ok)).toBe("sent");
    expect(ok).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(
      signalGroup(4242, 0, () => {
        throw errno("ESRCH");
      }),
    ).toBe("gone");
    expect(
      signalGroup(4242, "SIGKILL", () => {
        throw errno("EPERM");
      }),
    ).toBe("denied");
    // Any other error reads as gone; the callers' fallback covers it.
    expect(
      signalGroup(4242, "SIGTERM", () => {
        throw errno("EINVAL");
      }),
    ).toBe("gone");
  });

  it.each([0, 1, -5, undefined, 2.5])("pgid %s is gone and makes no call", (pgid) => {
    const kill = vi.fn();
    expect(signalGroup(pgid, "SIGKILL", kill)).toBe("gone");
    expect(kill).not.toHaveBeenCalled();
  });

  it("a real detached group: sent for SIGTERM, then gone for signal 0 once both members ended", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const pgid = child.pid!;
    expect(pgid).toBeGreaterThan(1);
    try {
      // The background sleep may not be forked yet; the probe answers for the shell either way.
      expect(signalGroup(pgid, 0)).toBe("sent");
      expect(signalGroup(pgid, "SIGTERM")).toBe("sent");
      await exited;
      // The orphaned sleep got the SIGTERM too; its reap by init can lag a little.
      let probe = signalGroup(pgid, 0);
      for (let i = 0; i < 100 && probe !== "gone"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        probe = signalGroup(pgid, 0);
      }
      expect(probe).toBe("gone");
    } finally {
      // A failed test leaves no member behind.
      if (signalGroup(pgid, 0) === "sent") signalGroup(pgid, "SIGKILL");
    }
  }, 15_000);
});
