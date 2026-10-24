import Foundation

/// Text for the status item title, its tooltip and the window header (KTD6).
public enum Format {
    /// The `tidegap ui` page link with the client token in the fragment (U17).
    /// `view` (for example "settings") asks the page to open that view first.
    public static func pageURL(port: Int, token: String, view: String? = nil) -> URL? {
        URL(string: "http://127.0.0.1:\(port)/#token=\(token)" + (view.map { "&view=\($0)" } ?? ""))
    }

    /// The page view of the job form for a new job (`&view=` and `#/` value).
    public static let newJobView = "jobs/new"

    /// The page view of one job's form, "jobs/<id>". Nil for an id outside
    /// letters, digits, `-`, `_` and `~`: the value goes into a URL and a
    /// script string, so it never carries a quote or a separator.
    public static func jobView(_ jobId: String) -> String? {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_~")
        guard (1...128).contains(jobId.count), jobId.allSatisfy(allowed.contains) else { return nil }
        return "jobs/\(jobId)"
    }

    /// `text` cut in the middle to at most `limit` characters ("Weekly dep…audit").
    public static func middleTruncate(_ text: String, limit: Int = 40) -> String {
        guard text.count > limit, limit > 1 else { return text }
        let keep = limit - 1
        let head = text.prefix((keep + 1) / 2)
        let tail = text.suffix(keep / 2)
        return "\(head)…\(tail)"
    }

    /// A job's second menu line: "next 02:00 · last ok 03:12",
    /// "running now · last failed Oct 18 21:40", "paused after 3 failures".
    public static func jobLine(_ job: Job, now: Date, timeZone: TimeZone = .current) -> String {
        func time(_ date: Date) -> String { when(date, now: now, timeZone: timeZone) }
        var parts: [String] = []
        if job.isPaused {
            parts.append(pausedText(job))
        } else if job.isRunning {
            parts.append("running now")
        } else if let run = job.nextRun {
            if let date = run.scheduledFor {
                parts.append("next \(time(date))")
            } else if let date = run.earliest {
                parts.append("next after \(time(date))")
            }
        }
        if let last = job.lastRun, let outcome = last.outcome {
            let suffix = (last.completedAt ?? last.startedAt).map { " " + time($0) } ?? ""
            parts.append("last \(outcome)\(suffix)")
        }
        return parts.isEmpty ? "no run planned" : parts.joined(separator: " · ")
    }

    private static func pausedText(_ job: Job) -> String {
        guard job.pauseReason?.hasPrefix("auto") == true else { return "paused" }
        guard let failures = job.consecutiveFailures, failures > 0 else { return "paused after failures" }
        return "paused after \(failures) failure\(failures == 1 ? "" : "s")"
    }

    /// The text next to the menu bar icon. Empty when nothing is queued and
    /// nothing runs: the clean window lives in the tooltip and the window
    /// header, never here, so the item never reads like a clock.
    /// "3" queued, "●" running, "● 2" running plus two more, "?" no token,
    /// "off" no server. When readiness says tasks will not run, a "!" goes
    /// in front ("!3", "!" alone when empty).
    public static func statusTitle(state: ConnectionState, summary: Summary?) -> String {
        if state.lacksToken { return "?" }
        if case .connecting = state { return "" }
        guard case .connected = state, let summary else { return "off" }
        let base = queueTitle(summary)
        return summary.notReadyLine == nil ? base : "!" + base
    }

    private static func queueTitle(_ summary: Summary) -> String {
        let running = summary.counts.running
        let rest = max(summary.active - running, 0)
        let count = rest > 99 ? "99+" : rest > 0 ? String(rest) : ""
        guard running > 0 else { return count }
        return count.isEmpty ? "●" : "● \(count)"
    }

    /// The first line of the tooltip and the window header: the clean window
    /// when connected, else the connection state.
    public static func headline(state: ConnectionState, summary: Summary?, timeZone: TimeZone = .current) -> String {
        switch state {
        case .connecting: return "Connecting to tidegap ui…"
        case .connected: return summary.map { header($0, timeZone: timeZone) } ?? "Connected"
        case .offline: return "tidegap ui is not reachable"
        case .revoked: return "Access revoked"
        case .needsUpdate: return "Update tidegap to 0.19 or later"
        case .tidegapNotFound: return "tidegap not found"
        case .failed(let message): return message
        }
    }

    /// The line under the headline: "3 active · 1 running · 1 unread", or
    /// what to do about the connection state.
    public static func detail(state: ConnectionState, summary: Summary?) -> String? {
        switch state {
        case .connected:
            guard let s = summary else { return nil }
            var parts = ["\(s.active) active"]
            if s.counts.running > 0 { parts.append("\(s.counts.running) running") }
            if s.unread > 0 { parts.append("\(s.unread) unread") }
            return parts.joined(separator: " · ")
        case .revoked: return "The token was revoked or removed. Reconnect creates a new one."
        case .needsUpdate(let version): return "Found \(version). Or point Settings at a newer build."
        case .tidegapNotFound: return "Set the tidegap command in Settings."
        case .offline(let message): return message
        default: return nil
        }
    }

    /// The status item tooltip: headline, detail, the Claude limit line and
    /// the not-ready line, one per line.
    public static func tooltip(state: ConnectionState, summary: Summary?, timeZone: TimeZone = .current) -> String {
        var lines = ["Tidegap", headline(state: state, summary: summary, timeZone: timeZone)]
        if let detail = detail(state: state, summary: summary) { lines.append(detail) }
        if state.isConnected, let summary {
            if let limits = summary.limitsLine { lines.append(limits) }
            if let notReady = summary.notReadyLine { lines.append(notReady) }
        }
        return lines.joined(separator: "\n")
    }

    /// "Clean 14:00-17:00 · FR", "Clean now until 17:00 · FR",
    /// "Cleanest 14:00 · FR" (fallback) or "Forecast unavailable".
    public static func header(_ summary: Summary, timeZone: TimeZone = .current) -> String {
        guard let window = summary.cleanWindow else { return "Forecast unavailable" }
        let region = summary.region.map { " · \($0)" } ?? ""
        let start = clock(window.start, timeZone: timeZone)
        let end = clock(window.end, timeZone: timeZone)
        if window.fallback { return "Cleanest \(start)\(region)" }
        if window.now { return "Clean now until \(end)\(region)" }
        return "Clean \(start)-\(end)\(region)"
    }

    /// "14:00" in 24-hour time.
    public static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        format(date, "HH:mm", timeZone: timeZone)
    }

    private static func format(_ date: Date, _ pattern: String, timeZone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = pattern
        return f.string(from: date)
    }

    /// A task row's time: the planned run, else the deadline.
    public static func rowTime(_ task: TaskItem, now: Date, timeZone: TimeZone = .current) -> String {
        guard let date = task.scheduledFor ?? task.deadline else { return "" }
        let prefix = task.scheduledFor != nil ? "runs" : "by"
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if calendar.isDate(date, inSameDayAs: now) { return "\(prefix) \(clock(date, timeZone: timeZone))" }
        return "\(prefix) \(format(date, "MMM d HH:mm", timeZone: timeZone))"
    }

    /// "14:00" today, "Oct 18 09:00" another day.
    public static func when(_ date: Date, now: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if calendar.isDate(date, inSameDayAs: now) { return clock(date, timeZone: timeZone) }
        return format(date, "MMM d HH:mm", timeZone: timeZone)
    }

    /// A Later menu item: "Tonight · 22:00", or "After limit reset — needs the reset time".
    public static func laterItem(_ option: LaterOption, now: Date, timeZone: TimeZone = .current) -> String {
        guard option.available else { return "\(option.label) — \(option.reason ?? "not available")" }
        guard let at = option.notBefore else { return option.label }
        return "\(option.label) · \(when(at, now: now, timeZone: timeZone))"
    }

    /// The one line after an action succeeded; `task` is the server's answer.
    public static func done(_ action: TaskAction, task: TaskItem, now: Date, timeZone: TimeZone = .current) -> String {
        switch action {
        case .cancel: return "Cancelled"
        case .runNow: return "Runs on the next tick"
        case .later:
            guard let at = task.scheduledFor ?? task.notBefore else { return "Moved" }
            return "Moved to \(when(at, now: now, timeZone: timeZone))"
        }
    }
}
