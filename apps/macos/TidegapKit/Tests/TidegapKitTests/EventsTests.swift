import Foundation
import Testing
@testable import TidegapKit

@Suite struct EventsTests {
    func done(_ id: String, _ title: String? = nil, status: TaskStatus = .completed) -> FinishedTask {
        FinishedTask(taskId: id, title: title ?? id, status: status, completedAt: date("2026-10-17T09:59:00Z"))
    }

    func window(_ start: String, fallback: Bool = false, now: Bool = false) -> CleanWindow {
        let s = date(start)
        return CleanWindow(start: s, end: s.addingTimeInterval(3 * 3600), band: "clean", g: 90, now: now, fallback: fallback)
    }

    @Test func firstCallIsSilentAndStoresCursor() {
        var saved: [String] = []
        let d = EventDeriver(cursor: nil, saveCursor: { saved.append($0) })
        #expect(d.derive(summary(cursor: "c0")).isEmpty)
        #expect(d.cursor == "c0")
        #expect(saved == ["c0"])
    }

    @Test func twoFinishedGiveTwoEventsAndRepeatsGiveNone() {
        // AE3: each finished task is announced once.
        let d = EventDeriver(cursor: "c0")
        let s = summary(finished: [done("b"), done("a", status: .failed)], cursor: "c1")
        #expect(d.derive(s) == [.taskFinished(done("a", status: .failed)), .taskFinished(done("b"))])
        #expect(d.derive(s).isEmpty)
        #expect(d.cursor == "c1")
    }

    @Test func windowIsAnnouncedOnceAndReplaced() {
        let d = EventDeriver(cursor: "c0")
        let w1 = window("2026-10-17T14:00:00Z")
        #expect(d.derive(summary(window: w1)) == [.cleanWindow(w1)])
        #expect(d.derive(summary(window: w1)).isEmpty)
        let w2 = window("2026-10-17T15:00:00Z")
        #expect(d.derive(summary(window: w2)) == [.cleanWindow(w2)])
    }

    @Test func fallbackWindowSchedulesNothing() {
        let d = EventDeriver(cursor: "c0")
        #expect(d.derive(summary(window: window("2026-10-17T14:00:00Z", fallback: true))).isEmpty)
        let w = window("2026-10-17T14:00:00Z")
        _ = d.derive(summary(window: w))
        #expect(d.derive(summary(window: window("2026-10-17T14:00:00Z", fallback: true))) == [.cleanWindowCleared])
    }

    @Test func startedWindowKeepsItsRequest() {
        let d = EventDeriver(cursor: "c0")
        let w = window("2026-10-17T14:00:00Z")
        _ = d.derive(summary(window: w))
        let started = summary(window: window("2026-10-17T14:00:00Z", now: true), generatedAt: date("2026-10-17T14:05:00Z"))
        #expect(d.derive(started).isEmpty)
    }

    @Test func togglesSilenceEachKind() {
        let d = EventDeriver(cursor: "c0")
        let off = NotificationToggles(taskFinished: false, cleanWindow: false)
        let s = summary(window: window("2026-10-17T14:00:00Z"), finished: [done("a")], cursor: "c1")
        #expect(d.derive(s, toggles: off).isEmpty)
        #expect(d.cursor == "c1")
        let onlyWindow = NotificationToggles(taskFinished: false, cleanWindow: true)
        #expect(d.derive(s, toggles: onlyWindow) == [.cleanWindow(window("2026-10-17T14:00:00Z"))])
        #expect(d.derive(s, toggles: off) == [.cleanWindowCleared])
    }

    @Test func titlesArePlainAndTruncatedAt100() {
        let long = String(repeating: "x", count: 150)
        let content = NotificationText.content(for: .taskFinished(done("a", long)))
        #expect(content?.title == "Task completed")
        #expect(content?.body.count == 100)
        #expect(content?.body.hasSuffix("…") == true)
        #expect(NotificationText.truncate("<b>line one</b>\nline two") == "<b>line one</b> line two")
        #expect(NotificationText.content(for: .taskFinished(done("a", status: .failed)))?.title == "Task failed")
    }

    @Test func aFailedTaskShowsTheFirstLineOfItsError() {
        var failed = done("t-1", "Nightly report", status: .failed)
        failed.error = "stopped: command time limit 5 min"
        let content = NotificationText.content(for: .taskFinished(failed))
        #expect(content?.title == "Task failed")
        #expect(content?.body == "Nightly report\nstopped: command time limit 5 min")
        // The server's line is at most 140 characters plus an ellipsis; it arrives unchanged.
        failed.error = String(repeating: "y", count: 140) + "…"
        #expect(NotificationText.content(for: .taskFinished(failed))?.body == "Nightly report\n" + String(repeating: "y", count: 140) + "…")
    }

    @Test func theFailedNotificationOffersRetryOnlyWhenTheServerAllowsIt() {
        var failed = done("t-5", "Deploy check", status: .failed)
        #expect(NotificationText.category(for: .taskFinished(failed)) == nil)
        failed.retry = true
        #expect(NotificationText.category(for: .taskFinished(failed)) == NotificationText.retryCategory)
        var completed = done("t-6", "Deploy check")
        completed.retry = true
        #expect(NotificationText.category(for: .taskFinished(completed)) == nil)
        #expect(NotificationText.category(for: .cleanWindowCleared) == nil)
    }

    @Test func withoutAnErrorTheBodyIsTheTitle() {
        #expect(NotificationText.content(for: .taskFinished(done("t-2", "Nightly report", status: .failed)))?.body == "Nightly report")
        var empty = done("t-3", "Nightly report", status: .failed)
        empty.error = ""
        #expect(NotificationText.content(for: .taskFinished(empty))?.body == "Nightly report")
        #expect(NotificationText.content(for: .taskFinished(done("t-4", "Nightly report")))?.body == "Nightly report")
    }
}
