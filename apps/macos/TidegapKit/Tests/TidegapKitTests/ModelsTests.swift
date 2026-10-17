import Foundation
import Testing
@testable import TidegapKit

/// Summary example from docs/spec/ui-client-api.md.
let summaryFixture = """
{
  "generated_at": "2026-10-17T10:00:00.000Z",
  "region": "FR",
  "counts": { "queued": 2, "scheduled": 1, "running": 1, "submitted": 1 },
  "active": 5,
  "unread": 1,
  "next_run": { "task_id": "t1", "title": "Nightly report", "scheduled_for": "2026-10-17T13:00:00.000Z" },
  "clean_window": { "start": "2026-10-17T14:00:00.000Z", "end": "2026-10-17T17:00:00.000Z", "band": "clean", "g": 104, "now": false, "fallback": false },
  "forecast_ok": true,
  "finished": [{ "task_id": "t0", "title": "Done one", "status": "completed", "completed_at": "2026-10-17T09:58:00.000Z" }],
  "cursor": "2026-10-17T09:58:00.000Z"
}
"""

@Suite struct ModelsTests {
    @Test func decodesSummaryWithFinished() throws {
        let s = try Wire.decoder().decode(Summary.self, from: Data(summaryFixture.utf8))
        #expect(s.region == "FR")
        #expect(s.counts == Counts(queued: 2, scheduled: 1, running: 1, submitted: 1))
        #expect(s.active == 5)
        #expect(s.nextRun?.taskId == "t1")
        #expect(s.cleanWindow?.start == Wire.parseDate("2026-10-17T14:00:00Z"))
        #expect(s.cleanWindow?.fallback == false)
        #expect(s.finished?.first?.status == .completed)
        #expect(s.cursor == "2026-10-17T09:58:00.000Z")
    }

    @Test func decodesSummaryWithoutFinishedAndNulls() throws {
        let json = """
        {"generated_at":"2026-10-17T10:00:00.000Z","region":"FR",
         "counts":{"queued":0,"scheduled":0,"running":0,"submitted":0},
         "active":0,"unread":0,"next_run":null,"clean_window":null,
         "forecast_ok":false,"cursor":"2026-10-17T10:00:00.000Z"}
        """
        let s = try Wire.decoder().decode(Summary.self, from: Data(json.utf8))
        #expect(s.finished == nil)
        #expect(s.cleanWindow == nil)
        #expect(s.nextRun == nil)
        #expect(s.forecastOk == false)
    }

    @Test func decodesTaskListWithUnknownStatus() throws {
        let json = """
        {"last_tick_at":null,"tasks":[
          {"task_id":"a","title":null,"display_title":"Write tests","status":"queued","deadline":"2026-10-18T10:00:00.000Z","scheduled_for":null,"completed_at":null,"region":"FR"},
          {"task_id":"b","title":"x","display_title":"x","status":"paused_by_future_cli","deadline":null,"scheduled_for":"2026-10-17T14:00:00Z","completed_at":null}
        ]}
        """
        let list = try Wire.decoder().decode(TaskList.self, from: Data(json.utf8))
        #expect(list.tasks.count == 2)
        #expect(list.tasks[0].status == .queued)
        #expect(list.tasks[0].label == "Write tests")
        #expect(list.tasks[1].status == .other("paused_by_future_cli"))
    }

    @Test func summaryWithoutReadinessDecodesNil() throws {
        // A 0.19.0 server sends no readiness.
        let s = try Wire.decoder().decode(Summary.self, from: Data(summaryFixture.utf8))
        #expect(s.readiness == nil)
        #expect(s.notReadyLine == nil)
    }

    @Test func summaryReadinessNotReadyGivesTheLine() throws {
        let json = summaryFixture.replacingOccurrences(of: #""cursor": "2026-10-17T09:58:00.000Z""#, with: #""cursor": "2026-10-17T09:58:00.000Z", "readiness": {"ready": false, "line": "Tasks will not run: no tick daemon. Run `tidegap install`.", "problems": [{"code": "no_daemon", "message": "Tasks will not run: no tick daemon.", "fix": "tidegap install"}], "notes": [], "ticker": {"daemon": "not_installed"}}"#)
        let s = try Wire.decoder().decode(Summary.self, from: Data(json.utf8))
        #expect(s.readiness?.problems?.first?.code == "no_daemon")
        #expect(s.notReadyLine == "Tasks will not run: no tick daemon. Run `tidegap install`.")
        #expect(Readiness(ready: true, line: nil).notReadyLine == nil)
    }

    @Test func laterOptionsAndActionsDecode() throws {
        let json = """
        {"last_tick_at":null,"tasks":[
          {"task_id":"a","title":null,"display_title":"A","status":"scheduled","deadline":null,"scheduled_for":"2026-10-17T14:00:00.000Z","not_before":null,"completed_at":null,
           "actions":{"cancel":true,"stopSeries":false,"reschedule":true,"runNow":false,"later":true,"reply":false,"markRead":false},
           "later_options":[
             {"preset":"tonight","label":"Tonight","not_before":"2026-10-17T19:00:00.000Z","available":true},
             {"preset":"after_limit_reset","label":"After limit reset","not_before":null,"available":false,"reason":"needs the reset time"}
           ]},
          {"task_id":"b","display_title":"B","status":"queued","actions":{"cancel":true,"runNow":true}}
        ]}
        """
        let list = try Wire.decoder().decode(TaskList.self, from: Data(json.utf8))
        let a = list.tasks[0], b = list.tasks[1]
        #expect(a.actions == TaskActions(cancel: true, runNow: false, later: true))
        #expect(a.laterOptions?.first == LaterOption(preset: "tonight", label: "Tonight", notBefore: date("2026-10-17T19:00:00Z"), available: true))
        #expect(a.laterOptions?.last == LaterOption(preset: "after_limit_reset", label: "After limit reset", notBefore: nil, available: false, reason: "needs the reset time"))
        #expect(a.canPostpone && a.canCancel && !a.canRunNow)
        // 0.19.0 item: no later_options, no "later" action: no Later menu.
        #expect(b.laterOptions == nil && b.actions?.later == nil && !b.canPostpone && b.canRunNow)
    }
}
