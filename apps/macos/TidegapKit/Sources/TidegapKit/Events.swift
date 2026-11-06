import Foundation

/// What a summary change means for the user (KTD8).
public enum ClientEvent: Equatable, Sendable {
    case taskFinished(FinishedTask)
    /// A clean window to announce at its start. It replaces any earlier one.
    case cleanWindow(CleanWindow)
    /// The announced window is gone (forecast changed, or only a fallback).
    case cleanWindowCleared
}

/// One delivery path for events. v1 has one: macOS notifications. The
/// Integrations registry can replace the list later (KTD8).
public protocol NotificationChannel: AnyObject {
    func deliver(_ event: ClientEvent)
}

public struct NotificationToggles: Equatable, Sendable {
    public var taskFinished: Bool
    public var cleanWindow: Bool

    public init(taskFinished: Bool = true, cleanWindow: Bool = true) {
        self.taskFinished = taskFinished
        self.cleanWindow = cleanWindow
    }
}

/// Turns summaries into events. The cursor is the server's (AE3); `saveCursor`
/// persists it so a relaunch does not repeat finished tasks.
public final class EventDeriver {
    public private(set) var cursor: String?
    private let saveCursor: (String) -> Void
    private var seen: [String] = []
    private var announcedStart: Date?

    public init(cursor: String?, saveCursor: @escaping (String) -> Void = { _ in }) {
        self.cursor = cursor
        self.saveCursor = saveCursor
    }

    /// The events for one summary. The first summary (no cursor yet) is silent
    /// for finished tasks.
    public func derive(_ summary: Summary, toggles: NotificationToggles = .init()) -> [ClientEvent] {
        var events: [ClientEvent] = []
        if cursor != nil, toggles.taskFinished {
            for task in (summary.finished ?? []).reversed() where !seen.contains(task.taskId) {
                events.append(.taskFinished(task))
            }
        }
        for task in summary.finished ?? [] where !seen.contains(task.taskId) {
            seen.append(task.taskId)
        }
        if seen.count > 200 { seen.removeFirst(seen.count - 200) }
        if cursor != summary.cursor {
            cursor = summary.cursor
            saveCursor(summary.cursor)
        }

        let window = summary.cleanWindow.flatMap { toggles.cleanWindow && !$0.fallback ? $0 : nil }
        if let window, window.start > summary.generatedAt {
            if window.start != announcedStart {
                announcedStart = window.start
                events.append(.cleanWindow(window))
            }
        } else if announcedStart != nil, window?.start != announcedStart {
            // Gone, fallback-only or switched off. A window that has begun
            // keeps its (delivered) request.
            announcedStart = nil
            events.append(.cleanWindowCleared)
        }
        return events
    }
}

/// Notification text. Titles come from prompts: plain text only, truncated.
public enum NotificationText {
    public static let maxTitle = 100
    /// The server's error line: 140 characters plus its ellipsis.
    public static let maxErrorLine = 141

    public static func truncate(_ text: String, to limit: Int = maxTitle) -> String {
        let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        guard flat.count > limit else { return flat }
        return String(flat.prefix(limit - 1)) + "…"
    }

    public static func content(for event: ClientEvent, timeZone: TimeZone = .current) -> (title: String, body: String)? {
        switch event {
        case .taskFinished(let task):
            let title = truncate(task.title ?? task.taskId)
            guard task.status == .failed else { return ("Task completed", title) }
            guard let error = task.error, !error.isEmpty else { return ("Task failed", title) }
            return ("Task failed", "\(title)\n\(truncate(error, to: maxErrorLine))")
        case .cleanWindow(let window):
            let start = Format.clock(window.start, timeZone: timeZone)
            let end = Format.clock(window.end, timeZone: timeZone)
            return ("Clean window now", "Clean grid \(start)-\(end). Queued tasks can run.")
        case .cleanWindowCleared:
            return nil
        }
    }
}
