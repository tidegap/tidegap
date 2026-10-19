import Foundation

/// Text for the menu bar label and the menu header (KTD6).
public enum Format {
    /// The `tidegap ui` page link with the client token in the fragment (U17).
    /// `view` (for example "settings") asks the page to open that view first.
    public static func pageURL(port: Int, token: String, view: String? = nil) -> URL? {
        URL(string: "http://127.0.0.1:\(port)/#token=\(token)" + (view.map { "&view=\($0)" } ?? ""))
    }

    /// The menu bar text, in KTD6 priority order. The Mac shows the start clock
    /// time of a later window instead of hours left.
    /// When readiness says tasks will not run, the text gets a "!" in front
    /// ("!3", "!" alone when empty).
    public static func label(state: ConnectionState, summary: Summary?, timeZone: TimeZone = .current) -> String {
        if state.lacksToken { return "?" }
        guard case .connected = state, let summary else { return "off" }
        let base = baseLabel(summary, timeZone: timeZone)
        return summary.notReadyLine == nil ? base : "!" + base
    }

    private static func baseLabel(_ summary: Summary, timeZone: TimeZone) -> String {
        if summary.active > 99 { return "99+" }
        if summary.active > 0 { return String(summary.active) }
        guard let window = summary.cleanWindow else { return "" }
        if window.now { return "now" }
        return clock(window.start, timeZone: timeZone)
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
