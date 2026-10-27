import Foundation

// Codable shapes of the `tidegap ui` client API (docs/spec/ui-client-api.md).

/// Task status. A status this build does not know decodes to `.other`.
public enum TaskStatus: Equatable, Hashable, Sendable, Codable {
    case queued, scheduled, running, submitted, completed, failed, cancelled
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "queued": self = .queued
        case "scheduled": self = .scheduled
        case "running": self = .running
        case "submitted": self = .submitted
        case "completed": self = .completed
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .queued: return "queued"
        case .scheduled: return "scheduled"
        case .running: return "running"
        case .submitted: return "submitted"
        case .completed: return "completed"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        case .other(let s): return s
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    /// The statuses `GET /api/summary` counts as active.
    public static let active: [TaskStatus] = [.queued, .scheduled, .running, .submitted]
}

public struct Counts: Codable, Equatable, Sendable {
    public var queued: Int
    public var scheduled: Int
    public var running: Int
    public var submitted: Int
}

public struct NextRun: Codable, Equatable, Sendable {
    public var taskId: String
    public var title: String?
    public var scheduledFor: Date?
}

public struct CleanWindow: Codable, Equatable, Sendable {
    public var start: Date
    public var end: Date
    public var band: String
    public var g: Double?
    public var now: Bool
    public var fallback: Bool

    public init(start: Date, end: Date, band: String, g: Double?, now: Bool, fallback: Bool) {
        self.start = start
        self.end = end
        self.band = band
        self.g = g
        self.now = now
        self.fallback = fallback
    }
}

public struct FinishedTask: Codable, Equatable, Sendable {
    public var taskId: String
    public var title: String?
    public var status: TaskStatus
    public var completedAt: Date

    public init(taskId: String, title: String?, status: TaskStatus, completedAt: Date) {
        self.taskId = taskId
        self.title = title
        self.status = status
        self.completedAt = completedAt
    }
}

/// `GET /api/summary[?since=<iso>]`.
public struct Summary: Codable, Equatable, Sendable {
    public var generatedAt: Date
    public var region: String?
    public var counts: Counts
    public var active: Int
    public var unread: Int
    public var nextRun: NextRun?
    public var cleanWindow: CleanWindow?
    public var forecastOk: Bool
    public var finished: [FinishedTask]?
    /// Server clock; send it back as `since`. Kept as the server's string.
    public var cursor: String
    /// "Will queued tasks run?" Nil from a 0.19.0 server: show nothing.
    public var readiness: Readiness? = nil
    /// The Claude limit line. Nil from a 0.19 server or when the server has no reading.
    public var limits: Limits? = nil
    /// Active and paused job counts. Nil from a server without jobs: hide the Jobs menu.
    public var jobs: JobCounts? = nil
    /// The active job whose pending run starts first, or nil.
    public var nextJobRun: NextJobRun? = nil

    /// The readiness sentence when tasks will not run, else nil.
    public var notReadyLine: String? { readiness?.notReadyLine }

    /// "Claude 5h: 72%, resets 16:30", or nil when there is nothing to show
    /// (no `limits`, `limits: null`, or the empty line of disabled reads).
    public var limitsLine: String? {
        guard let line = limits?.line, !line.isEmpty else { return nil }
        return line
    }
}

/// The `limits` object of `/api/summary` (spec, "Limits"). The server
/// formats the line in its local time, which is this Mac's.
public struct Limits: Codable, Equatable, Sendable {
    public var line: String
    /// `ok`, `unavailable` or `disabled`.
    public var status: String
    public var pct: Double?
    /// ISO-8601, kept as the server's string.
    public var resetsAt: String?

    public init(line: String, status: String, pct: Double? = nil, resetsAt: String? = nil) {
        self.line = line
        self.status = status
        self.pct = pct
        self.resetsAt = resetsAt
    }
}

/// The readiness object of `/api/summary` (spec, "Readiness"). Only the
/// fields the menu shows; every string is text, never markup.
public struct Readiness: Codable, Equatable, Sendable {
    public var ready: Bool
    public var line: String?
    public var problems: [Problem]?

    public struct Problem: Codable, Equatable, Sendable {
        public var code: String
        public var message: String?
        public var fix: String?
    }

    public init(ready: Bool, line: String?, problems: [Problem]? = nil) {
        self.ready = ready
        self.line = line
        self.problems = problems
    }

    public var notReadyLine: String? {
        guard !ready else { return nil }
        if let line, !line.isEmpty { return line }
        return "Tasks will not run."
    }
}

/// Which buttons a task row enables (the list item's `actions`).
public struct TaskActions: Codable, Equatable, Sendable {
    public var cancel: Bool
    public var runNow: Bool
    /// Nil from a 0.19.0 server, which has no Later.
    public var later: Bool?

    public init(cancel: Bool, runNow: Bool, later: Bool?) {
        self.cancel = cancel
        self.runNow = runNow
        self.later = later
    }
}

/// One Later preset of a list item (`later_options`).
public struct LaterOption: Codable, Equatable, Identifiable, Sendable {
    public var preset: String
    public var label: String
    /// The earliest start the preset would write; nil when unavailable.
    public var notBefore: Date?
    public var available: Bool
    /// One line to show on a disabled preset.
    public var reason: String?

    public var id: String { preset }

    public init(preset: String, label: String, notBefore: Date?, available: Bool, reason: String? = nil) {
        self.preset = preset
        self.label = label
        self.notBefore = notBefore
        self.available = available
        self.reason = reason
    }
}

/// One row of `GET /api/tasks`.
public struct TaskItem: Codable, Equatable, Identifiable, Sendable {
    public var taskId: String
    public var title: String?
    public var displayTitle: String?
    public var status: TaskStatus
    public var deadline: Date?
    public var scheduledFor: Date?
    public var completedAt: Date?
    public var notBefore: Date? = nil
    public var actions: TaskActions? = nil
    /// Nil from a 0.19.0 server: hide the Later menu.
    public var laterOptions: [LaterOption]? = nil

    public var id: String { taskId }
    public var label: String { displayTitle ?? title ?? taskId }

    public var canCancel: Bool { actions?.cancel ?? false }
    public var canRunNow: Bool { actions?.runNow ?? false }
    /// Later shows only when the server sends presets and allows it.
    public var canPostpone: Bool { laterOptions != nil && (actions?.later ?? false) }
}

public struct TaskList: Codable, Equatable, Sendable {
    public var tasks: [TaskItem]
}

/// `POST /api/tasks/<id>/postpone` body: exactly one of the two.
public enum LaterChoice: Equatable, Sendable {
    /// `1h`, `tonight`, `tomorrow_morning` or `after_limit_reset`.
    case preset(String)
    /// An exact time ("Pick a time").
    case until(Date)
}

/// The per-task actions of the menu.
public enum TaskAction: String, Equatable, Sendable {
    case later, cancel, runNow

    /// Cancel and Run now ask once before they act.
    public var confirmQuestion: String? {
        switch self {
        case .cancel: return "Cancel this task?"
        case .runNow: return "Run this task on the next tick?"
        case .later: return nil
        }
    }
}

/// The `jobs` counts of `/api/summary`.
public struct JobCounts: Codable, Equatable, Sendable {
    public var active: Int
    public var paused: Int

    public init(active: Int, paused: Int) {
        self.active = active
        self.paused = paused
    }
}

/// The `next_job_run` of `/api/summary`.
public struct NextJobRun: Codable, Equatable, Sendable {
    public var jobId: String
    public var title: String?
    public var at: Date?
}

/// Which job items show, for this caller (the job's `actions`).
/// Every flag is optional: a missing one hides its item.
public struct JobActions: Codable, Equatable, Sendable {
    public var edit: Bool?
    public var pause: Bool?
    public var resume: Bool?
    public var runNow: Bool?
    public var remove: Bool?

    public init(edit: Bool? = nil, pause: Bool? = nil, resume: Bool? = nil, runNow: Bool? = nil, remove: Bool? = nil) {
        self.edit = edit
        self.pause = pause
        self.resume = resume
        self.runNow = runNow
        self.remove = remove
    }
}

/// A job's pending run (`next_run`).
public struct JobRun: Codable, Equatable, Sendable {
    public var taskId: String?
    public var status: TaskStatus?
    public var earliest: Date?
    public var deadline: Date?
    public var scheduledFor: Date?
    /// When a `running` or `submitted` run was dispatched; nil otherwise and
    /// on a server older than the field.
    public var startedAt: Date?

    public init(
        taskId: String? = nil, status: TaskStatus? = nil, earliest: Date? = nil, deadline: Date? = nil,
        scheduledFor: Date? = nil, startedAt: Date? = nil
    ) {
        self.taskId = taskId
        self.status = status
        self.earliest = earliest
        self.deadline = deadline
        self.scheduledFor = scheduledFor
        self.startedAt = startedAt
    }
}

/// A job's newest finished run (`last_run`).
public struct JobLastRun: Codable, Equatable, Sendable {
    public var taskId: String?
    /// `ok`, `failed` or `skipped`.
    public var outcome: String?
    public var startedAt: Date?
    public var completedAt: Date?
    /// At most 300 characters, redacted by the server; text, never markup.
    public var preview: String?

    public init(taskId: String? = nil, outcome: String? = nil, startedAt: Date? = nil, completedAt: Date? = nil, preview: String? = nil) {
        self.taskId = taskId
        self.outcome = outcome
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.preview = preview
    }
}

/// One job of `GET /api/jobs` (spec, "Jobs"). Only the fields the menu
/// shows; all but the id are optional so a newer or older server decodes.
public struct Job: Codable, Equatable, Identifiable, Sendable {
    public var jobId: String
    public var title: String?
    /// `active`, `paused` or `removed`.
    public var status: String?
    public var guarantee: String?
    public var nextRun: JobRun?
    public var lastRun: JobLastRun?
    public var consecutiveFailures: Int?
    /// `manual`, or `auto: <first error line>`.
    public var pauseReason: String?
    public var actions: JobActions?

    public init(
        jobId: String, title: String? = nil, status: String? = nil, guarantee: String? = nil,
        nextRun: JobRun? = nil, lastRun: JobLastRun? = nil, consecutiveFailures: Int? = nil,
        pauseReason: String? = nil, actions: JobActions? = nil
    ) {
        self.jobId = jobId
        self.title = title
        self.status = status
        self.guarantee = guarantee
        self.nextRun = nextRun
        self.lastRun = lastRun
        self.consecutiveFailures = consecutiveFailures
        self.pauseReason = pauseReason
        self.actions = actions
    }

    public var id: String { jobId }
    public var label: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? jobId }
    public var isPaused: Bool { status == "paused" }
    /// Running on this host, or submitted to a provider batch: either way
    /// the run is in flight and Run now stays hidden.
    public var isRunning: Bool { nextRun?.status == .running || nextRun?.status == .submitted }

    public var canPause: Bool { actions?.pause ?? false }
    public var canResume: Bool { actions?.resume ?? false }
    /// Hidden while a run is running, whatever the flag says.
    public var canRunNow: Bool { (actions?.runNow ?? false) && !isRunning }
    public var canEdit: Bool { actions?.edit ?? false }
}

public struct JobList: Codable, Equatable, Sendable {
    public var jobs: [Job]
}

/// `GET /api/jobs` for the menu. `supported` is false when the server
/// answers 404 (older than jobs): hide the Jobs menu, no alert.
public struct JobsAnswer: Equatable, Sendable {
    public var jobs: [Job]
    public var supported: Bool

    public init(jobs: [Job], supported: Bool) {
        self.jobs = jobs
        self.supported = supported
    }
}

/// The per-job actions of the menu.
public enum JobAction: String, Equatable, Sendable {
    case pause, resume, runNow = "run-now"
}

/// `~/.tidegap/ui.json`.
public struct DiscoveryRecord: Codable, Equatable, Sendable {
    public var version: Int
    public var pid: Int32
    public var port: Int
    public var url: String?
    public var startedAt: String?
    public var cliVersion: String?
}

/// `tidegap clients add --json`.
public struct MintedClient: Codable, Equatable, Sendable {
    public var clientId: String
    public var token: String
}

public enum Wire {
    /// ISO-8601 with or without fractional seconds, as Node's `toISOString` writes.
    public static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    public static func formatDate(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            guard let date = parseDate(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "not an ISO-8601 instant: \(s)")
            }
            return date
        }
        return d
    }

    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(formatDate(date))
        }
        e.outputFormatting = [.sortedKeys]
        return e
    }
}
