import { describe, expect, it } from "vitest";

import { ATTACHMENT_LINE_CHARS, callbackFits, eventMessage, jobEndedMessage, jobPausedMessage, runPreview, runVerdict, telegramCommands, notReadyMessage, queueMessage, resultMessages, splitMessage, taskDoneMessage, taskFailedMessage, TELEGRAM_MESSAGE_MAX } from "../src/index.js";
import type { RunSession, TaskRecord } from "../src/index.js";
import { clipEscaped } from "../src/channels/kinds/shared.js";

function rec(over: Partial<TaskRecord<unknown>> & { spec?: Record<string, unknown> } = {}): TaskRecord<unknown> {
  const { spec, ...rest } = over;
  return {
    taskId: "t-1",
    status: "completed",
    enqueuedAt: "2026-10-17T10:00:00Z",
    completedAt: "2026-10-17T11:00:00Z",
    region: "DE",
    title: "Weekly digest",
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "Weekly digest", ...spec }),
    ...rest,
  } as TaskRecord<unknown>;
}

describe("channel texts", () => {
  it("a 5000-character result previews 600 characters", () => {
    const text = "a".repeat(5000);
    const msg = taskDoneMessage(rec({ result: { text } }));
    expect(msg.text).toContain(`${"a".repeat(600)}…`);
    expect(msg.text).not.toContain("a".repeat(601));
    expect(msg.buttons).toEqual([[{ text: "Result", data: "r:t-1" }]]);
  });

  describe("where a claude-code task ran (R12)", () => {
    const receipt = (session: RunSession) => ({ taskId: "t-1", ranAt: "2026-10-17T11:00:00Z", region: "DE", estimatedCarbonGCo2: 0.1, session });
    const ORIGIN = "11111111-2222-4333-8444-555555555555";

    it("a fork names the short session id and the directory's last segment only", () => {
      const msg = taskDoneMessage(
        rec({
          originCwd: "/Users/someone/work/app",
          originSessionId: ORIGIN,
          receipt: receipt({ mode: "fork", sessionId: "f1a2b3c4-0000-4000-8000-000000000000", originSessionId: ORIGIN }),
          result: { text: "done" },
        }),
      );
      expect(msg.text).toContain("Ran in a copy of session 11111111 (app)");
      expect(msg.text).not.toContain("/Users/someone");
    });

    it("a fresh run names the reason", () => {
      const msg = taskDoneMessage(rec({ receipt: receipt({ mode: "fresh", reason: "too-large", contextTokens: 620_000 }) }));
      expect(msg.text).toContain("Ran in a fresh session: session too large");
    });

    it("a receipt without a session adds no line", () => {
      const before = taskDoneMessage(rec({ result: { text: "x" } })).text;
      const msg = taskDoneMessage(rec({ result: { text: "x" }, receipt: { taskId: "t-1", ranAt: "2026-10-17T11:00:00Z", region: "DE", estimatedCarbonGCo2: 0.1 } }));
      expect(msg.text).toBe(before);
      expect(msg.text).not.toContain("Ran in");
    });
  });

  it("a redactInReceipt task has no preview", () => {
    const msg = taskDoneMessage(rec({ result: { text: "secret output" }, spec: { redactInReceipt: ["secret"] } }));
    expect(msg.text).not.toContain("secret output");
    expect(msg.text).toContain("tidegap queue show t-1");
  });

  it("/result for a redactInReceipt task sends no result text", () => {
    const out = resultMessages(rec({ result: { text: "secret output" }, spec: { redactInReceipt: ["x"] } }));
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain("This task is redacted; run `tidegap queue show t-1`");
    expect(out[0]!.text).not.toContain("secret output");
  });

  it("/result splits at 4096 characters into at most 4 messages, then points to queue show", () => {
    const out = resultMessages(rec({ result: { text: "b".repeat(20_000) } }));
    expect(out).toHaveLength(5);
    expect(out.every((m) => m.text.length <= TELEGRAM_MESSAGE_MAX)).toBe(true);
    expect(out[4]!.text).toContain("tidegap queue show t-1");
  });

  it("/result keeps the first message within 4096 UTF-16 units under a title of 80 emoji", () => {
    const out = resultMessages(rec({ title: "🌊".repeat(90), result: { text: "b".repeat(20_000) } }));
    expect(out[0]!.text.startsWith(`${"🌊".repeat(80)}…\n\nb`)).toBe(true);
    expect(out.map((m) => m.text.length <= TELEGRAM_MESSAGE_MAX)).toEqual([true, true, true, true, true]);
  });

  it("a failed task shows the first error line and no buttons", () => {
    const msg = taskFailedMessage(rec({ status: "failed", error: "rate limited\nstack..." }));
    expect(msg.text).toContain("Failed: Weekly digest");
    expect(msg.text).toContain("rate limited");
    expect(msg.text).not.toContain("stack");
    expect(msg.buttons).toBeUndefined();
  });

  it("a failed task skips a line of only control characters, folds tabs and spaces, and cuts at 300", () => {
    expect(taskFailedMessage(rec({ status: "failed", error: "\u0007\u0007\nclaude-code: limit reached" })).text.split("\n")).toContain("claude-code: limit reached");
    expect(taskFailedMessage(rec({ status: "failed", error: "exit 1:\tno   such file" })).text.split("\n")).toContain("exit 1: no such file");
    expect(taskFailedMessage(rec({ status: "failed", error: "z".repeat(400) })).text.split("\n")).toContain(`${"z".repeat(300)}…`);
  });

  it("a failed task says unknown error only when no line has visible text", () => {
    expect(taskFailedMessage(rec({ status: "failed", error: "\u0007\n \u001b " })).text.split("\n")).toContain("unknown error");
  });

  it("not ready names the daemon for ticker problems", () => {
    const msg = notReadyMessage([{ code: "daemon_stale", message: "Tasks may not run: the tick daemon last ran 11 minutes ago.", fix: "tidegap install" }]);
    expect(msg.text).toBe("Tidegap: the tick daemon is not running.\nTasks may not run: the tick daemon last ran 11 minutes ago. Run `tidegap install`.");
  });

  it("a recovery heads the message 'running again' and keeps any open problem", () => {
    expect(notReadyMessage([], true).text).toBe("Tidegap: the tick daemon is running again.");
    const msg = notReadyMessage([{ code: "no_runner", message: "Tasks will not run: 1 openai task has no runner.", fix: "add OPENAI_API_KEY to ~/.config/tidegap/env" }], true);
    expect(msg.text.split("\n")[0]).toBe("Tidegap: the tick daemon is running again.");
    expect(msg.text.split("\n")).toHaveLength(2);
  });

  it("the queue numbers tasks and gives each a row of allowed buttons", () => {
    const pending = rec({ status: "scheduled", completedAt: undefined, scheduledFor: "2099-01-01T10:00:00Z" });
    const running = rec({ taskId: "t-2", status: "running", completedAt: undefined, title: "Running one" });
    const msg = queueMessage([pending, running]);
    expect(msg.ids).toEqual(["t-1", "t-2"]);
    expect(msg.text).toContain("1. Weekly digest");
    expect(msg.text).toContain("2. Running one · running");
    expect(msg.buttons).toEqual([
      [
        { text: "1 Later ▾", data: "l:t-1" },
        { text: "1 Run now", data: "x:t-1" },
        { text: "1 Cancel", data: "c:t-1" },
      ],
      [{ text: "2 Cancel", data: "c:t-2" }],
    ]);
  });

  it("splitMessage keeps every part within the limit", () => {
    expect(splitMessage("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"]);
    expect(splitMessage("", 4)).toEqual([""]);
  });

  it("splitMessage cuts between grapheme clusters, never inside a surrogate pair, a skin tone or a flag, and ends under a cap of one unit", () => {
    expect(splitMessage("x😀😀", 2)).toEqual(["x", "😀", "😀"]);
    expect(splitMessage("ab👍🏽cd", 4)).toEqual(["ab", "👍🏽", "cd"]);
    expect(splitMessage("abc🇺🇸de", 4)).toEqual(["abc", "🇺🇸", "de"]);
    expect(splitMessage("ab\nc👨\u200D👩\u200D👧", 8)).toEqual(["ab\nc", "👨\u200D👩\u200D👧"]);
    expect(splitMessage("👨\u200D👩\u200D👧", 4)).toEqual(["👨\u200D", "👩\u200D", "👧"]);
    expect(splitMessage("😀a", 1)).toEqual(["😀", "a"]);
  });

  it("clipEscaped (Slack, Discord) cuts between grapheme clusters and never ends in half an escape", () => {
    expect(clipEscaped("ab😀cd", 4)).toBe("ab…");
    expect(clipEscaped("aa🇺🇸x", 5)).toBe("aa…");
    expect(clipEscaped("a👍🏽bcd", 6)).toBe("a👍🏽…");
    expect(clipEscaped("abc\\*d", 5)).toBe("abc…");
    expect(clipEscaped("abcd", 4)).toBe("abcd");
  });
});

describe("callbackFits", () => {
  it("accepts default ids and refuses ids that would overflow 64 bytes or break parsing", () => {
    expect(callbackFits("t-0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(callbackFits("series-1~12")).toBe(true);
    expect(callbackFits("x".repeat(70))).toBe(false);
    expect(callbackFits("has:colon")).toBe(false);
  });
});

describe("telegramCommands", () => {
  it("parses HELP_TEXT into Bot API valid commands", () => {
    const cmds = telegramCommands();
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("skips malformed lines", () => {
    const help = ["/ok - fine", "no slash - x", "/Bad - upper", "/x", "/a-b - dash", "/later <n> - with args"].join("\n");
    expect(telegramCommands(help)).toEqual([
      { command: "ok", description: "fine" },
      { command: "later", description: "with args" },
    ]);
  });
});

describe("job occurrence messages (jobs R22, KTD10)", () => {
  const now = new Date("2026-10-17T12:00:00Z");

  it("done: '<job title> — <first line>'; a short one-line result is not repeated below", () => {
    const msg = taskDoneMessage(rec({ result: { text: "3 messages need a reply" } }), now, "Mail triage");
    expect(msg.text.split("\n")[0]).toBe("☑️ Mail triage — 3 messages need a reply");
    expect(msg.text.match(/3 messages need a reply/g)).toHaveLength(1);
    expect(msg.buttons).toBeDefined();
  });

  it("done with a multi-line result: the first line as the verdict, then the lines after it", () => {
    const msg = taskDoneMessage(rec({ result: { text: "line one\nline two" } }), now, "Mail triage");
    expect(msg.text.split("\n")[0]).toBe("☑️ Mail triage — line one");
    expect(msg.text.endsWith("\n\nline two")).toBe(true);
    expect(msg.text.match(/line one/g)).toHaveLength(1);
  });

  it("done for a redacted task: no result or summary text, the title says done", () => {
    const msg = taskDoneMessage(
      rec({ result: { text: "secret output", summary: "secret summary", summaryError: "summarize: secret" }, spec: { redactInReceipt: ["secret"] } }),
      now,
      "Mail triage",
      "Sun 10:05",
    );
    expect(msg.text.split("\n")[0]).toBe("☑️ Mail triage — done");
    expect(msg.text).toContain("this task redacts its receipt");
    expect(msg.text).not.toMatch(/secret (output|summary)|No summary/);
  });

  it("failed: '❌ <job title>: failed' and the first error line", () => {
    const msg = taskFailedMessage(rec({ status: "failed", error: "ssh: connect timed out\nmore" }), now, "Deploy logs");
    expect(msg.text.split("\n")[0]).toBe("❌ Deploy logs: failed");
    expect(msg.text.split("\n")).toContain("ssh: connect timed out");
  });

  it("the pause notice cuts its reason at 200 and skips a control-only line", () => {
    const notice = { jobId: "job-1", title: "deploy logs", reason: `\u0007\n${"r".repeat(250)}` };
    expect(jobPausedMessage(notice).text.split("\n")[0]).toBe(`❌ job 'deploy logs' paused after 3 failures: ${"r".repeat(200)}…`);
  });

  it("the end notice names the job, why it ended and its last run with its verdict or error", () => {
    const byDate = { jobId: "job-1", title: "deploy watch", reason: "until" as const, until: "2026-11-17", lastOutcome: "failed" as const };
    const failed = rec({ taskId: "job-1~5", status: "failed", error: `\nssh: ${"t".repeat(200)}\nmore` });
    expect(jobEndedMessage(byDate, failed).text).toBe(
      `🏁 Job ended: "deploy watch"\n"deploy watch" ended: its end date (2026-11-17) passed.\nLast run: job-1~5 failed: ssh: ${"t".repeat(114)}…`,
    );
    const byCount = { jobId: "job-1", title: "deploy watch", reason: "count" as const, lastOutcome: "ok" as const };
    const ok = rec({ taskId: "job-1~2", result: { text: "raw report", summary: "All fine.\n\nNothing changed." } });
    expect(jobEndedMessage(byCount, ok).text.split("\n").slice(1)).toEqual(['"deploy watch" ended: its runs are done.', "Last run: job-1~2 ok: All fine."]);
    expect(jobEndedMessage(byCount, rec({ taskId: "job-1~2", result: { text: " " } })).text.split("\n").pop()).toBe("Last run: job-1~2 ok.");
    const attention = rec({ taskId: "job-1~2", result: { text: "raw report", summary: "ATTENTION: Referral share dropped.\n- Check the widget." } });
    expect(jobEndedMessage(byCount, attention).text.split("\n").pop()).toBe("Last run: job-1~2 ok: Referral share dropped.");
  });

  it("the pause notice names the job, the count and the reason, then how to resume", () => {
    const notice = { jobId: "job-1", title: "deploy logs", reason: "ssh: connect timed out" };
    expect(jobPausedMessage(notice).text).toBe("❌ job 'deploy logs' paused after 3 failures: ssh: connect timed out\nResume it: tidegap jobs resume job-1");
  });
});

describe("runPreview (KTD6): one run preview for the jobs page and the digest", () => {
  const KEY = "sk-ant-AAAAABBBBBBCCCCCCDDDDDD";

  it("a failed task: the first error line with visible text, redacted", () => {
    const error = `\n\u0001\u0007\u001b\nlogin failed with ${KEY}\nsecond line`;
    const out = runPreview(rec({ status: "failed", error, result: undefined }), 300);
    expect(out).toBe("login failed with [REDACTED]");
  });

  it("a completed task: one line, redacted; a 400-character text gives exactly maxChars code points", () => {
    expect(runPreview(rec({ result: { text: `found\n\n  ${KEY}\tthere` } }), 300)).toBe("found [REDACTED] there");
    const long = "€".repeat(400);
    const page = runPreview(rec({ result: { text: long } }), 300)!;
    expect(Array.from(page)).toHaveLength(300);
    expect(page.endsWith(`${"€".repeat(299)}…`)).toBe(true);
    expect(Array.from(runPreview(rec({ result: { text: long } }), 200)!)).toHaveLength(200);
    expect(runPreview(rec({ result: { text: "x".repeat(300) } }), 300)).toBe("x".repeat(300));
  });

  it("cuts by code point, never inside a surrogate pair", () => {
    const out = runPreview(rec({ result: { text: "😀".repeat(10) } }), 5)!;
    expect(out).toBe(`${"😀".repeat(4)}…`);
  });

  it("a redacted completed task, a cancelled task and an empty result give undefined", () => {
    expect(runPreview(rec({ result: { text: "secret output" }, spec: { redactInReceipt: ["secret"] } }), 300)).toBeUndefined();
    expect(runPreview(rec({ status: "cancelled", result: { text: "partial" } }), 300)).toBeUndefined();
    expect(runPreview(rec({ result: { text: " \n\t " } }), 300)).toBeUndefined();
    expect(runPreview(rec({ status: "failed", error: "\n \n" }), 300)).toBeUndefined();
  });
});

describe("readable job notices", () => {
  const REPORT = [
    "[monitor] signup-funnel 2026-11-14T10:04:51Z env=prod window=24h baseline=7d",
    "visits|18911|base 18204|d +3.9%|thr 15%|OK",
    "signup_rate|4.18%|base 4.21%|d -0.7%|thr 10%|OK",
    "referral_share|9.1%|base 11.8%|d -22.9%|thr 15%|WARN",
    "coupon_redeemed|305|base 312|d -2.2%|thr 20%|OK",
    "api_5xx|12|base 14|d -14.3%|thr 50%|OK",
    "summary: 1 WARN, 4 OK",
  ].join("\n");
  const VERDICT = "Referral share dropped; the rest is normal.";
  const BODY =
    "Referral share fell to 9.1% from its 7-day level of 11.8%, past the 15% alert limit. Visits, signups, coupons and server errors are in their usual range. Check the referral widget on the checkout page.";
  const SHAPED = [
    `ATTENTION: ${VERDICT}`,
    "- Checked: visits, signups, referral share, coupons and server errors over 24 hours.",
    "- Changed: referral share is 9.1% against 11.8% over 7 days, past the 15% limit.",
    "- Action: check the referral widget on the checkout page.",
  ].join("\n");
  // Local time, so the Finished label reads 10:05 in any zone.
  const finished = new Date(2026, 10, 14, 10, 5, 0);
  const now = new Date(2026, 10, 14, 10, 6, 0);
  const run = (result: Record<string, unknown>, over: Partial<TaskRecord<unknown>> = {}) =>
    rec({ taskId: "job-3f9a1c2e~1", completedAt: finished.toISOString(), result, ...over });
  const TITLE = "Signup funnel monitor";

  it("a summary in the requested shape: the status emoji, the verdict, • lines, one raw Result button", () => {
    const msg = taskDoneMessage(run({ text: REPORT, summary: SHAPED }), now, TITLE, "Sun 10:05");
    expect(msg.text).toBe(
      [
        "⚠️ Signup funnel monitor — Referral share dropped; the rest is normal.",
        "Finished 10:05 · next Sun 10:05",
        "",
        "• Checked: visits, signups, referral share, coupons and server errors over 24 hours.",
        "• Changed: referral share is 9.1% against 11.8% over 7 days, past the 15% limit.",
        "• Action: check the referral widget on the checkout page.",
      ].join("\n"),
    );
    expect(msg.buttons).toEqual([[{ text: "Result", data: "r:job-3f9a1c2e~1" }]]);
    expect(resultMessages(run({ text: REPORT, summary: SHAPED })).map((m) => m.text).join("\n")).toContain(REPORT);
  });

  it("a verdict and a paragraph without a status word: ☑️ and one • line per sentence", () => {
    const msg = taskDoneMessage(run({ text: REPORT, summary: `${VERDICT}\n\n${BODY}` }), now, TITLE, "Sun 10:05");
    expect(msg.text).toBe(
      [
        "☑️ Signup funnel monitor — Referral share dropped; the rest is normal.",
        "Finished 10:05 · next Sun 10:05",
        "",
        "• Referral share fell to 9.1% from its 7-day level of 11.8%, past the 15% alert limit.",
        "• Visits, signups, coupons and server errors are in their usual range.",
        "• Check the referral widget on the checkout page.",
      ].join("\n"),
    );
  });

  it("a summary in another language keeps the fixed words in English", () => {
    const reply = [
      "ATTENTION: Доля рефералов упала, остальное в норме.",
      "- Проверено: визиты, регистрации, доля рефералов, купоны и ошибки сервера за 24 часа.",
      "- Изменилось: доля рефералов 9,1% против 11,8% за 7 дней, ниже порога 15%.",
      "- Действие: проверьте реферальный виджет на странице оформления заказа.",
    ].join("\n");
    expect(taskDoneMessage(run({ text: REPORT, summary: reply }), now, TITLE, "Sun 10:05").text).toBe(
      [
        "⚠️ Signup funnel monitor — Доля рефералов упала, остальное в норме.",
        "Finished 10:05 · next Sun 10:05",
        "",
        "• Проверено: визиты, регистрации, доля рефералов, купоны и ошибки сервера за 24 часа.",
        "• Изменилось: доля рефералов 9,1% против 11,8% за 7 дней, ниже порога 15%.",
        "• Действие: проверьте реферальный виджет на странице оформления заказа.",
      ].join("\n"),
    );
  });

  it("a run without a summary: ☑️, the first output line as the verdict, then the raw lines after it", () => {
    const msg = taskDoneMessage(run({ text: REPORT }), now, TITLE, "Sun 10:05");
    expect(msg.text).toBe(
      [
        "☑️ Signup funnel monitor — [monitor] signup-funnel 2026-11-14T10:04:51Z env=prod window=24h baseline=7d",
        "Finished 10:05 · next Sun 10:05",
        "",
        "visits|18911|base 18204|d +3.9%|thr 15%|OK",
        "signup_rate|4.18%|base 4.21%|d -0.7%|thr 10%|OK",
        "referral_share|9.1%|base 11.8%|d -22.9%|thr 15%|WARN",
        "coupon_redeemed|305|base 312|d -2.2%|thr 20%|OK",
        "api_5xx|12|base 14|d -14.3%|thr 50%|OK",
        "summary: 1 WARN, 4 OK",
      ].join("\n"),
    );
  });

  it("a failed run of the job: ❌ and the error line", () => {
    const msg = taskFailedMessage(run({}, { status: "failed", error: "exit 1: monitor.sh: connection refused" }), now, TITLE);
    expect(msg.text.split("\n").slice(0, 3)).toEqual(["❌ Signup funnel monitor: failed", "Failed 10:05", "exit 1: monitor.sh: connection refused"]);
  });

  it("line 1 drops bidirectional controls from the job title and the raw verdict", () => {
    const msg = taskDoneMessage(run({ text: "\u202Eevil\u202C all fine\u2066\nmore" }), now, "Job\u202Etitle", "Sun 10:05");
    expect(msg.text.split("\n")[0]).toBe("☑️ Jobtitle — evil all fine");
  });

  it("a summary with no usable verdict falls back to the raw text and ☑️", () => {
    const msg = taskDoneMessage(run({ text: REPORT, summary: "ATTENTION:\n\n---" }), now, TITLE);
    expect(msg.text.split("\n")[0]).toBe(`☑️ ${TITLE} — ${REPORT.split("\n")[0]}`);
    expect(msg.text).toContain("summary: 1 WARN, 4 OK");
  });

  it("a failed summary adds one No summary line after Finished, cut at 120, and keeps the raw lines", () => {
    const msg = taskDoneMessage(run({ text: REPORT, summaryError: "summarize: stopped: budget 1.00 USD reached\nmore" }), now, TITLE, "Sun 10:05");
    expect(msg.text).toBe(
      `☑️ ${TITLE} — ${REPORT.split("\n")[0]}\nFinished 10:05 · next Sun 10:05\nNo summary: summarize: stopped: budget 1.00 USD reached\n\n${REPORT.split("\n").slice(1).join("\n")}`,
    );
    const long = taskDoneMessage(run({ text: REPORT, summaryError: `summarize: ${"e".repeat(300)}` }), now, TITLE).text.split("\n")[2]!;
    expect(long).toBe(`No summary: summarize: ${"e".repeat(108)}…`);
  });

  it("a one-line summary longer than 120: the verdict ends with …, its rest is the first • line, cut at 200", () => {
    const lines = taskDoneMessage(run({ text: REPORT, summary: "w".repeat(700) }), now, TITLE).text.split("\n");
    expect(lines[0]).toBe(`☑️ ${TITLE} — ${"w".repeat(119)}…`);
    expect(lines.slice(2)).toEqual(["", `• ${"w".repeat(199)}…`]);
  });

  it("no summary and a 150-character first line: line 1 cut at 120, the body is the whole raw preview", () => {
    const text = `${"f".repeat(150)}\nsecond`;
    const lines = taskDoneMessage(run({ text }), now, TITLE).text.split("\n");
    expect(lines[0]).toBe(`☑️ ${TITLE} — ${"f".repeat(119)}…`);
    expect(lines.slice(2)).toEqual(["", "f".repeat(150), "second"]);
  });

  it("the body stays within 600 characters", () => {
    const summary = ["OK: x", ...Array.from({ length: 4 }, (_, i) => `- ${String(i).repeat(250)}`)].join("\n");
    const body = taskDoneMessage(run({ text: REPORT, summary }), now, TITLE).text.split("\n\n")[1]!;
    expect(Array.from(body).length).toBeLessThanOrEqual(600);
  });

  it("the job title and the raw body are cut between grapheme clusters", () => {
    const title = `${"t".repeat(79)}👍🏽x`;
    expect(taskDoneMessage(run({ text: "done" }), now, title).text.split("\n")[0]).toBe(`☑️ ${"t".repeat(79)}… — done`);
    const body = taskDoneMessage(run({ text: `first line\n${"r".repeat(599)}🇺🇸x` }), now, TITLE).text.split("\n\n")[1]!;
    expect(body).toBe(`${"r".repeat(599)}…`);
  });

  it("a one-line result of 50 characters and no summary: the verdict only, no body", () => {
    const text = "x".repeat(50);
    expect(taskDoneMessage(run({ text }), now, TITLE).text).toBe(`☑️ ${TITLE} — ${text}\nFinished 10:05`);
  });

  it("no next part when the next run is running now or unknown; an empty result says done", () => {
    expect(taskDoneMessage(run({ text: "ok" }), now, TITLE, "running now").text).toBe(`☑️ ${TITLE} — ok\nFinished 10:05`);
    expect(taskDoneMessage(run({ text: "ok" }), now, TITLE).text).toBe(`☑️ ${TITLE} — ok\nFinished 10:05`);
    expect(taskDoneMessage(run({ text: "" }), now, TITLE, "~Sun 10:05").text).toBe(`☑️ ${TITLE} — done\nFinished 10:05 · next ~Sun 10:05`);
  });

  it("a one-off task keeps its Done and Failed texts, byte for byte", () => {
    expect(taskDoneMessage(run({ text: REPORT, summary: SHAPED }), now).text).toBe(`Done: Weekly digest\nFinished 10:05\n\n${REPORT}`);
    expect(taskFailedMessage(run({}, { status: "failed", error: "boom" }), now).text).toBe("Failed: Weekly digest\nFailed 10:05\nboom\nRun `tidegap queue show job-3f9a1c2e~1`.");
  });

  it("the event passes jobNext through; the Result button replies with the raw report", () => {
    const task = run({ text: REPORT, summary: SHAPED });
    const msg = eventMessage({ kind: "task_done", task, jobTitle: TITLE, jobNext: "Sun 10:05" }, now);
    expect(msg.text.split("\n").slice(0, 2)).toEqual([`⚠️ ${TITLE} — ${VERDICT}`, "Finished 10:05 · next Sun 10:05"]);
    expect(resultMessages(task).map((m) => m.text).join("\n")).toContain(REPORT);
    expect(resultMessages(task).map((m) => m.text).join("\n")).not.toContain(VERDICT);
  });

  it("runVerdict: the summary's verdict without the status word, else the output's first line; a failed run's first error line; none for a redacted run", () => {
    expect(runVerdict(run({ text: REPORT, summary: `\n${VERDICT}\n\n${BODY}` }))).toBe(VERDICT);
    expect(runVerdict(run({ text: REPORT, summary: SHAPED }))).toBe(VERDICT);
    expect(runVerdict(run({ text: `\n  ${REPORT}` }))).toBe(REPORT.split("\n")[0]);
    expect(runVerdict(run({ text: REPORT }), 20)).toBe(`${REPORT.slice(0, 19)}…`);
    expect(runVerdict(rec({ status: "failed", error: "\nboom\nmore" }))).toBe("boom");
    expect(runVerdict(run({ text: "x", summary: "y" }, { bodyJson: JSON.stringify({ type: "provider_call", redactInReceipt: ["x"] }) }))).toBeUndefined();
    expect(runVerdict(run({ text: " " }))).toBeUndefined();
  });

  it("runPreview: the summary as one line when there is one, else the output", () => {
    expect(runPreview(run({ text: REPORT, summary: `${VERDICT}\n\n${BODY}` }), 300)).toBe(`${VERDICT} ${BODY}`);
    expect(runPreview(run({ text: "a\nb" }), 300)).toBe("a b");
  });

  describe("attachments", () => {
    const FILES = [
      { name: "funnel.png", type: "image/png", bytes: 49152, file: "1.png" },
      { name: "weekly.csv", type: "text/csv", bytes: 2048, file: "2.csv" },
    ];
    const AE1_AFTER = [
      "⚠️ Signup funnel monitor — Referral share dropped; the rest is normal.",
      "Finished 10:05 · next Sun 10:05",
      "📎 funnel.png (48 KB), weekly.csv (2 KB)",
      "",
      "• Checked: visits, signups, referral share, coupons and server errors over 24 hours.",
      "• Changed: referral share is 9.1% against 11.8% over 7 days, past the 15% limit.",
      "• Action: check the referral widget on the checkout page.",
    ].join("\n");

    it("covers the funnel example: the 📎 line after the time line, and the files go with the notice", () => {
      const msg = taskDoneMessage(run({ text: REPORT, summary: SHAPED, attachments: FILES }), now, TITLE, "Sun 10:05");
      expect(msg.text).toBe(AE1_AFTER);
      expect(msg.files).toEqual({ taskId: "job-3f9a1c2e~1", attachments: FILES.map((f, i) => ({ ...f, index: i + 1 })) });
      expect(msg.buttons).toEqual([[{ text: "Result", data: "r:job-3f9a1c2e~1" }]]);
    });

    it("a third file over the cap adds the not attached part", () => {
      const msg = taskDoneMessage(
        run({ text: REPORT, summary: SHAPED, attachments: FILES, attachmentsSkipped: [{ name: "huge.png", reason: "over 10 MB" }] }),
        now,
        TITLE,
        "Sun 10:05",
      );
      expect(msg.text.split("\n")[2]).toBe("📎 funnel.png (48 KB), weekly.csv (2 KB), not attached: huge.png (over 10 MB)");
      expect(eventMessage({ kind: "task_done", task: run({ text: REPORT, summary: SHAPED, attachmentsSkipped: [{ name: "huge.png", reason: "over 10 MB" }] }), jobTitle: TITLE, jobNext: "Sun 10:05" }, now).text.split("\n")[2]).toBe(
        "📎 not attached: huge.png (over 10 MB)",
      );
    });

    it("the 📎 line stays within its cap with four long names and skipped files, so the summary still fits a Pushover body", () => {
      const long = (n: number) => ({ name: `${String(n).repeat(76)}.png`, type: "image/png", bytes: 49152, file: `${n}.png` });
      const skipped = Array.from({ length: 10 }, (_, i) => ({ name: `${"s".repeat(70)}${i}.png`, reason: "over 10 MB" }));
      const line = taskDoneMessage(run({ text: REPORT, summary: SHAPED, attachments: [1, 2, 3, 4].map(long), attachmentsSkipped: skipped }), now, TITLE, "Sun 10:05").text.split("\n")[2]!;
      expect(line.startsWith("📎 ")).toBe(true);
      expect(Array.from(line)).toHaveLength(ATTACHMENT_LINE_CHARS);
      expect(line.endsWith("…")).toBe(true);
    });

    it("a redacted run names no file and sends none, on the notice and on the Result reply", () => {
      const redacted = run({ text: REPORT, attachments: FILES }, { bodyJson: JSON.stringify({ provider: "command", model: "none", prompt: "", redactInReceipt: ["x"] }) });
      const msg = taskDoneMessage(redacted, now, TITLE, "Sun 10:05");
      expect(msg.text.split("\n")[2]).toBe("📎 2 files, not sent: this task redacts its receipt");
      expect(msg.text).not.toContain("funnel.png");
      expect(msg.files).toBeUndefined();
      expect(resultMessages(redacted).some((m) => m.files)).toBe(false);
    });

    it("the Result reply: the raw text parts, then the files on the last one", () => {
      const out = resultMessages(run({ text: "x".repeat(9000), attachments: FILES }));
      expect(out.length).toBeGreaterThan(1);
      expect(out.slice(0, -1).every((m) => m.files === undefined)).toBe(true);
      expect(out.at(-1)!.files?.attachments.map((a) => a.file)).toEqual(["1.png", "2.csv"]);
      expect(resultMessages(run({ text: "", attachments: FILES })).at(-1)!.files?.attachments).toHaveLength(2);
    });

    it("a one-off task gets the line after its time line; a run without files keeps its text", () => {
      const oneOff = taskDoneMessage(rec({ completedAt: finished.toISOString(), result: { text: "ok", attachments: FILES.slice(0, 1) } }), now);
      expect(oneOff.text.split("\n").slice(0, 3)).toEqual(["Done: Weekly digest", "Finished 10:05", "📎 funnel.png (48 KB)"]);
      expect(taskDoneMessage(run({ text: REPORT, summary: SHAPED }), now, TITLE, "Sun 10:05").text).not.toContain("📎");
    });
  });
});
