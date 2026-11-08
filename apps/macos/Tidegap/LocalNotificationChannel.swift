import Foundation
import OSLog
import TidegapKit
import UserNotifications

/// macOS notifications for Kit events (R11, KTD8). Text goes only into
/// plain-text fields, truncated by `NotificationText`.
final class LocalNotificationChannel: NSObject, NotificationChannel, UNUserNotificationCenterDelegate {
    private static let cleanPrefix = "clean-"
    private let center = UNUserNotificationCenter.current()
    private let log = Logger(subsystem: "com.tidegap.mac", category: "notifications")
    /// Called when the user clicks a notification.
    var onOpen: (() -> Void)?
    /// Called with the task id when the user picks Retry on a failed-task notification.
    var onRetry: ((String) -> Void)?
    /// The task id travels in `userInfo`, never in the visible text.
    private static let taskIdKey = "task_id"

    override init() {
        super.init()
        center.delegate = self
        // Retry runs in the background: the task is due on the next tick, no window opens.
        let retry = UNNotificationAction(identifier: NotificationText.retryAction, title: "Retry", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: NotificationText.retryCategory, actions: [retry], intentIdentifiers: [], options: []),
        ])
    }

    /// Asked once, on the first connect.
    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound]) { [log] granted, error in
            if let error {
                log.error("notification authorization failed: \(error.localizedDescription, privacy: .public)")
            } else if !granted {
                log.notice("notifications not allowed; the menu bar keeps working")
            }
        }
    }

    func deliver(_ event: ClientEvent) {
        switch event {
        case .taskFinished(let task):
            add(id: "task-\(task.taskId)", event: event, trigger: nil)
        case .cleanWindow(let window):
            // One pending request: a new window replaces the old one. The
            // removal runs later, so it must spare the request added here.
            let id = Self.cleanPrefix + Wire.formatDate(window.start)
            removePendingCleanWindows(except: id)
            let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: window.start)
            let trigger = UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
            add(id: id, event: event, trigger: trigger)
        case .cleanWindowCleared:
            removePendingCleanWindows()
        }
    }

    private func add(id: String, event: ClientEvent, trigger: UNNotificationTrigger?) {
        guard let text = NotificationText.content(for: event) else { return }
        let content = UNMutableNotificationContent()
        content.title = text.title
        content.body = text.body
        content.sound = .default
        if let category = NotificationText.category(for: event), case .taskFinished(let task) = event {
            content.categoryIdentifier = category
            content.userInfo = [Self.taskIdKey: task.taskId]
        }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger)) { [log] error in
            if let error { log.error("notification failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    private func removePendingCleanWindows(except keep: String? = nil) {
        center.getPendingNotificationRequests { [center] requests in
            let ids = requests.map(\.identifier).filter { $0.hasPrefix(Self.cleanPrefix) && $0 != keep }
            center.removePendingNotificationRequests(withIdentifiers: ids)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        if response.actionIdentifier == NotificationText.retryAction, let taskId = info[Self.taskIdKey] as? String {
            DispatchQueue.main.async { self.onRetry?(taskId) }
        } else {
            DispatchQueue.main.async { self.onOpen?() }
        }
        completionHandler()
    }
}
