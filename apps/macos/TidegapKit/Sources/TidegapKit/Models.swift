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
