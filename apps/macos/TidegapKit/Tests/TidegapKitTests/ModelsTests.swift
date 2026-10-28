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

/// The `Job` example from docs/spec/ui-client-api.md, "Jobs".
let jobFixture = """
{
  "job_id": "job-3f9a1c2e", "title": "Mail triage", "status": "active", "revision": 4,
  "cadence": { "kind": "daily" }, "window": { "start": "00:00", "end": "08:00" }, "time_zone": "Europe/Berlin",
  "guarantee": "runs every day between 00:00 and 08:00",
  "runner": "command",
  "command": "himalaya envelope list --page-size 50 --output json",
  "prompt": "Read the JSON. Say which messages need a reply today and why.",
  "provider": "claude-code", "model": null, "tools": "none", "cwd": "~", "secrets": ["IMAP_PASSWORD"], "missing_secrets": [],
  "caps": { "command_timeout_s": 300, "llm_timeout_s": 600, "max_budget_usd": 1.0, "output_cap_bytes": 10485760 },
  "notify": "every_run",
  "next_run": { "task_id": "job-3f9a1c2e~4", "status": "scheduled", "earliest": "2026-10-23T22:00:00.000Z", "deadline": "2026-10-24T06:00:00.000Z",
                "scheduled_for": "2026-10-24T01:00:00.000Z", "intensity_g_per_kwh": null, "via_batch": false,
                "started_at": null, "deferred_until": null },
  "last_run": { "task_id": "job-3f9a1c2e~3", "outcome": "ok", "started_at": "2026-10-23T01:12:00.000Z",
                "completed_at": "2026-10-23T01:13:05.000Z", "late": false, "preview": "3 messages need a reply; invoice from Hetzner due Monday" },
  "consecutive_failures": 0, "pause_reason": null, "origin_host": "page",
  "created_at": "2026-10-20T09:00:00.000Z", "updated_at": "2026-10-23T01:13:06.000Z",
  "actions": { "edit": true, "pause": true, "resume": false, "run_now": true, "remove": true }
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

    @Test func summaryWithLimitsGivesTheLine() throws {
        let json = summaryFixture.replacingOccurrences(of: #""cursor": "2026-10-17T09:58:00.000Z""#, with: #""cursor": "2026-10-17T09:58:00.000Z", "limits": {"line": "Claude 5h: 72%, resets 16:30", "status": "ok", "window": "five_hour", "pct": 72, "resets_at": "2026-10-17T16:30:00.000Z"}"#)
        let s = try Wire.decoder().decode(Summary.self, from: Data(json.utf8))
        #expect(s.limits == Limits(line: "Claude 5h: 72%, resets 16:30", status: "ok", pct: 72, resetsAt: "2026-10-17T16:30:00.000Z"))
        #expect(s.limitsLine == "Claude 5h: 72%, resets 16:30")
    }

    @Test func summaryWithoutLimitsOrNullLimitsShowsNoLine() throws {
        // A 0.19 server sends no limits; a server with no reading sends null.
        let old = try Wire.decoder().decode(Summary.self, from: Data(summaryFixture.utf8))
        #expect(old.limits == nil)
        #expect(old.limitsLine == nil)
        let json = summaryFixture.replacingOccurrences(of: #""cursor": "2026-10-17T09:58:00.000Z""#, with: #""cursor": "2026-10-17T09:58:00.000Z", "limits": null"#)
        #expect(try Wire.decoder().decode(Summary.self, from: Data(json.utf8)).limitsLine == nil)
        // Disabled reads: an empty line, shown like no limits.
        #expect(summary(limits: Limits(line: "", status: "disabled")).limitsLine == nil)
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

    @Test func decodesTheSpecJob() throws {
        let job = try Wire.decoder().decode(Job.self, from: Data(jobFixture.utf8))
        #expect(job.jobId == "job-3f9a1c2e")
        #expect(job.label == "Mail triage")
        #expect(job.isPaused == false)
        #expect(job.nextRun?.status == .scheduled)
        #expect(job.nextRun?.scheduledFor == date("2026-10-24T01:00:00Z"))
        #expect(job.nextRun?.startedAt == nil)
        #expect(job.lastRun?.outcome == "ok")
        #expect(job.lastRun?.completedAt == date("2026-10-23T01:13:05Z"))
        #expect(job.actions == JobActions(edit: true, pause: true, resume: false, runNow: true, remove: true))
        #expect(job.canPause && job.canRunNow && job.canEdit)
        #expect(job.canResume == false)
    }

    @Test func decodesAJobWithOnlyItsId() throws {
        let list = try Wire.decoder().decode(JobList.self, from: Data(#"{"jobs":[{"job_id":"job-1"}]}"#.utf8))
        let job = try #require(list.jobs.first)
        #expect(job.label == "job-1")
        #expect(job.nextRun == nil && job.lastRun == nil && job.actions == nil)
        #expect(!job.canPause && !job.canResume && !job.canRunNow && !job.canEdit)
    }

    @Test func runningRunHidesRunNow() {
        let actions = JobActions(edit: true, pause: true, resume: false, runNow: true)
        let idle = Job(jobId: "j", status: "active", nextRun: JobRun(status: .scheduled), actions: actions)
        let running = Job(jobId: "j", status: "active", nextRun: JobRun(status: .running), actions: actions)
        #expect(idle.canRunNow)
        #expect(running.canRunNow == false)
        #expect(running.canPause)
        let paused = Job(jobId: "j", status: "paused", actions: JobActions(edit: true, pause: false, resume: true, runNow: false))
        #expect(paused.isPaused && paused.canResume && !paused.canPause && !paused.canRunNow)
    }

    @Test func batchSubmittedRunCountsAsRunning() throws {
        let actions = JobActions(edit: true, pause: true, resume: false, runNow: true)
        let submitted = Job(jobId: "j", status: "active", nextRun: JobRun(status: .submitted), actions: actions)
        #expect(submitted.isRunning)
        #expect(submitted.canRunNow == false)
        let json = #"{"jobs":[{"job_id":"j","next_run":{"status":"running","started_at":"2026-10-23T21:40:00.000Z"}}]}"#
        let run = try #require(try Wire.decoder().decode(JobList.self, from: Data(json.utf8)).jobs.first?.nextRun)
        #expect(run.startedAt == date("2026-10-23T21:40:00Z"))
    }

    @Test func summaryJobFieldsAreOptional() throws {
        let old = try Wire.decoder().decode(Summary.self, from: Data(summaryFixture.utf8))
        #expect(old.jobs == nil && old.nextJobRun == nil)
        var json = summaryFixture
        json.removeLast(2)
        json += #","jobs":{"active":2,"paused":1},"next_job_run":{"job_id":"job-3f9a1c2e","title":"Mail triage","at":"2026-10-18T01:00:00.000Z"}}"#
        let s = try Wire.decoder().decode(Summary.self, from: Data(json.utf8))
        #expect(s.jobs == JobCounts(active: 2, paused: 1))
        #expect(s.nextJobRun?.jobId == "job-3f9a1c2e")
        #expect(s.nextJobRun?.at == date("2026-10-18T01:00:00Z"))
        var none = summaryFixture
        none.removeLast(2)
        none += #","jobs":{"active":0,"paused":0},"next_job_run":null}"#
        let idle = try Wire.decoder().decode(Summary.self, from: Data(none.utf8))
        #expect(idle.jobs == JobCounts(active: 0, paused: 0) && idle.nextJobRun == nil)
    }
}
