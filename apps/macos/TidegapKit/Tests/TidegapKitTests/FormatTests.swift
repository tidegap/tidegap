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
}
