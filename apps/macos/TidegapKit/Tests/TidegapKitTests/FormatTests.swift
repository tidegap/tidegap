import Foundation
import Testing
@testable import TidegapKit

@Suite struct FormatTests {
    let utc = TimeZone(identifier: "UTC")!
    let connected = ConnectionState.connected(port: 47931, ownsServer: false)

    func window(_ start: String, _ end: String, now: Bool = false, fallback: Bool = false) -> CleanWindow {
        CleanWindow(start: date(start), end: date(end), band: "clean", g: 100, now: now, fallback: fallback)
    }

    @Test func statusTitleShowsTheQueueNeverAClock() {
        let later = window("2026-10-17T14:00:00Z", "2026-10-17T17:00:00Z")
        let nowWindow = window("2026-10-17T09:00:00Z", "2026-10-17T17:00:00Z", now: true)
        #expect(Format.statusTitle(state: connected, summary: summary(window: later)) == "")
        #expect(Format.statusTitle(state: connected, summary: summary(window: nowWindow)) == "")
        #expect(Format.statusTitle(state: connected, summary: summary()) == "")
        #expect(Format.statusTitle(state: connected, summary: summary(active: 3, window: later)) == "3")
        #expect(Format.statusTitle(state: connected, summary: summary(active: 120)) == "99+")
    }

    @Test func statusTitleMarksARunningTask() {
        #expect(Format.statusTitle(state: connected, summary: summary(active: 1, running: 1)) == "●")
        #expect(Format.statusTitle(state: connected, summary: summary(active: 3, running: 1)) == "● 2")
        #expect(Format.statusTitle(state: connected, summary: summary(active: 4, running: 2)) == "● 2")
    }

    @Test func statusTitleForConnectionStates() {
        #expect(Format.statusTitle(state: .connecting, summary: nil) == "")
        #expect(Format.statusTitle(state: .revoked, summary: summary(active: 3)) == "?")
        #expect(Format.statusTitle(state: .needsUpdate(version: "0.18.0"), summary: nil) == "?")
        #expect(Format.statusTitle(state: .offline("x"), summary: summary(active: 3)) == "off")
    }

    @Test func tooltipCarriesTheCleanWindowAndRegion() {
        let later = window("2026-10-17T04:00:00Z", "2026-10-17T09:00:00Z")
        let s = summary(window: later, region: "US-MIDA-PJM", readiness: Readiness(ready: false, line: "Tasks will not run: no tick daemon."),
                        limits: Limits(line: "Claude 5h: 72%, resets 16:30", status: "ok"), unread: 1)
        #expect(Format.tooltip(state: connected, summary: s, timeZone: utc) == """
            Tidegap
            Clean 04:00-09:00 · US-MIDA-PJM
            0 active · 1 unread
            Claude 5h: 72%, resets 16:30
            Tasks will not run: no tick daemon.
            """)
        #expect(Format.tooltip(state: connected, summary: summary(active: 3, running: 1), timeZone: utc) == """
            Tidegap
            Forecast unavailable
            3 active · 1 running
            """)
        #expect(Format.tooltip(state: .revoked, summary: nil) == """
            Tidegap
            Access revoked
            The token was revoked or removed. Reconnect creates a new one.
            """)
    }

    @Test func headerStrings() {
        #expect(Format.header(summary(window: window("2026-10-17T14:00:00Z", "2026-10-17T17:00:00Z")), timeZone: utc)
            == "Clean 14:00-17:00 · FR")
        #expect(Format.header(summary(window: window("2026-10-17T09:00:00Z", "2026-10-17T17:00:00Z", now: true)), timeZone: utc)
            == "Clean now until 17:00 · FR")
        #expect(Format.header(summary(window: window("2026-10-17T14:00:00Z", "2026-10-17T15:00:00Z", fallback: true)), timeZone: utc)
            == "Cleanest 14:00 · FR")
        #expect(Format.header(summary(), timeZone: utc) == "Forecast unavailable")
    }

    @Test func statusTitleMarksNotReady() {
        let notReady = Readiness(ready: false, line: "Tasks will not run: no tick daemon. Run `tidegap install`.")
        #expect(Format.statusTitle(state: connected, summary: summary(active: 3, readiness: notReady)) == "!3")
        #expect(Format.statusTitle(state: connected, summary: summary(readiness: notReady)) == "!")
        #expect(Format.statusTitle(state: connected, summary: summary(active: 3, readiness: Readiness(ready: true, line: nil))) == "3")
        #expect(Format.statusTitle(state: .offline("x"), summary: summary(readiness: notReady)) == "off")
    }

    @Test func laterItemsAndDoneLines() {
        let now = date("2026-10-17T10:00:00Z")
        #expect(Format.laterItem(LaterOption(preset: "tonight", label: "Tonight", notBefore: date("2026-10-17T22:00:00Z"), available: true), now: now, timeZone: utc)
            == "Tonight · 22:00")
        #expect(Format.laterItem(LaterOption(preset: "tomorrow_morning", label: "Tomorrow morning", notBefore: date("2026-10-18T09:00:00Z"), available: true), now: now, timeZone: utc)
            == "Tomorrow morning · Oct 18 09:00")
        #expect(Format.laterItem(LaterOption(preset: "after_limit_reset", label: "After limit reset", notBefore: nil, available: false, reason: "needs the reset time"), now: now, timeZone: utc)
            == "After limit reset — needs the reset time")
        var task = TaskItem(taskId: "a", title: "t", displayTitle: nil, status: .scheduled, deadline: nil, scheduledFor: date("2026-10-17T22:00:00Z"), completedAt: nil)
        #expect(Format.done(.later, task: task, now: now, timeZone: utc) == "Moved to 22:00")
        task.scheduledFor = nil
        #expect(Format.done(.later, task: task, now: now, timeZone: utc) == "Moved")
        #expect(Format.done(.cancel, task: task, now: now, timeZone: utc) == "Cancelled")
        #expect(Format.done(.runNow, task: task, now: now, timeZone: utc) == "Runs on the next tick")
        #expect(TaskAction.cancel.confirmQuestion == "Cancel this task?")
        #expect(TaskAction.later.confirmQuestion == nil)
    }

    @Test func rowTime() {
        let now = date("2026-10-17T10:00:00Z")
        var task = TaskItem(taskId: "a", title: "t", displayTitle: nil, status: .scheduled,
                            deadline: date("2026-10-19T08:00:00Z"), scheduledFor: date("2026-10-17T14:00:00Z"), completedAt: nil)
        #expect(Format.rowTime(task, now: now, timeZone: utc) == "runs 14:00")
        task.scheduledFor = nil
        #expect(Format.rowTime(task, now: now, timeZone: utc) == "by Oct 19 08:00")
    }

    @Test func pageURL() {
        #expect(Format.pageURL(port: 47821, token: "tgc_x", view: "settings")?.absoluteString == "http://127.0.0.1:47821/#token=tgc_x&view=settings")
        #expect(Format.pageURL(port: 47821, token: "tgc_x")?.absoluteString == "http://127.0.0.1:47821/#token=tgc_x")
    }

    @Test func jobViewAcceptsOnlySafeIds() {
        #expect(Format.jobView("job-3f9a1c2e") == "jobs/job-3f9a1c2e")
        #expect(Format.jobView("job_1~2") == "jobs/job_1~2")
        #expect(Format.jobView("") == nil)
        #expect(Format.jobView("a'b") == nil)
        #expect(Format.jobView("a/b") == nil)
        #expect(Format.jobView("a&view=x") == nil)
        #expect(Format.newJobView == "jobs/new")
        #expect(Format.pageURL(port: 47931, token: "tgc_x", view: Format.jobView("job-1"))?.absoluteString
            == "http://127.0.0.1:47931/#token=tgc_x&view=jobs/job-1")
    }

    @Test func longTitlesAreCutInTheMiddle() {
        #expect(Format.middleTruncate("Mail triage") == "Mail triage")
        let long = String(repeating: "a", count: 25) + String(repeating: "z", count: 25)
        let cut = Format.middleTruncate(long)
        #expect(cut.count == 40)
        #expect(cut == String(repeating: "a", count: 20) + "…" + String(repeating: "z", count: 19))
        #expect(Format.middleTruncate(String(repeating: "x", count: 40)).count == 40)
    }

    @Test func jobLineShowsNextAndLast() {
        let now = date("2026-10-23T10:00:00Z")
        let job = Job(
            jobId: "j", status: "active",
            nextRun: JobRun(status: .scheduled, earliest: date("2026-10-23T22:00:00Z"), scheduledFor: date("2026-10-24T01:00:00Z")),
            lastRun: JobLastRun(outcome: "ok", completedAt: date("2026-10-23T03:12:00Z"))
        )
        #expect(Format.jobLine(job, now: now, timeZone: utc) == "next Oct 24 01:00 · last ok 03:12")
        var unplanned = job
        unplanned.nextRun?.scheduledFor = nil
        unplanned.lastRun = nil
        #expect(Format.jobLine(unplanned, now: now, timeZone: utc) == "next after 22:00")
        #expect(Format.jobLine(Job(jobId: "j", status: "active"), now: now, timeZone: utc) == "no run planned")
    }

    @Test func jobLineForRunningAndPaused() {
        let now = date("2026-10-23T10:00:00Z")
        let failed = JobLastRun(outcome: "failed", completedAt: date("2026-10-22T21:40:00Z"))
        let running = Job(jobId: "j", status: "active", nextRun: JobRun(status: .running), lastRun: failed)
        #expect(Format.jobLine(running, now: now, timeZone: utc) == "running now · last failed Oct 22 21:40")
        let auto = Job(jobId: "j", status: "paused", consecutiveFailures: 3, pauseReason: "auto: ssh: connect timed out")
        #expect(Format.jobLine(auto, now: now, timeZone: utc) == "paused after 3 failures")
        #expect(Format.jobLine(Job(jobId: "j", status: "paused", pauseReason: "manual"), now: now, timeZone: utc) == "paused")
    }

    @Test func jobLineForStartedAndBatchRuns() {
        let now = date("2026-10-23T22:00:00Z")
        let running = Job(jobId: "j", status: "active", nextRun: JobRun(status: .running, startedAt: date("2026-10-23T21:40:00Z")))
        #expect(Format.jobLine(running, now: now, timeZone: utc) == "running since 21:40")
        // The server sends `started_at` for a submitted run too; the line uses the deadline.
        let submitted = Job(
            jobId: "j", status: "active",
            nextRun: JobRun(status: .submitted, deadline: date("2026-10-23T23:30:00Z"), startedAt: date("2026-10-23T21:40:00Z")))
        #expect(Format.jobLine(submitted, now: now, timeZone: utc) == "in a provider batch, by 23:30")
        let tomorrow = Job(jobId: "j", status: "active", nextRun: JobRun(status: .submitted, deadline: date("2026-10-24T06:00:00Z")))
        #expect(Format.jobLine(tomorrow, now: now, timeZone: utc) == "in a provider batch, by Oct 24 06:00")
        let noDeadline = Job(jobId: "j", status: "active", nextRun: JobRun(status: .submitted))
        #expect(Format.jobLine(noDeadline, now: now, timeZone: utc) == "in a provider batch")
    }
}
