import AppKit
import Foundation
import Observation
import TidegapKit

/// App state for the status item, the window and Settings. It drives the Kit's
/// connect sequence, the event stream and the 60 s fallback poll.
@MainActor
@Observable
final class AppModel {
    private(set) var state: ConnectionState = .connecting
    private(set) var summary: Summary?
    /// Shows the page window; set by the app delegate to the status item's window.
    @ObservationIgnored var onShowWindow: () -> Void = {}
    /// The view the page window should show; set by "Integrations…", cleared by "Open Tidegap".
    private(set) var viewRequest: PageViewRequest?
    @ObservationIgnored private var viewRequestCount = 0

    @ObservationIgnored let paths: AppPaths
    @ObservationIgnored let controller: ConnectionController
    @ObservationIgnored private var stream: EventStream?
    @ObservationIgnored private var streamKey: String?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored let notifications = LocalNotificationChannel()
    @ObservationIgnored private var deriver: EventDeriver
    @ObservationIgnored private var askedForNotifications = false
    /// The Settings "Launch at login" toggle; off until the user turns it on.
    @ObservationIgnored let launchAtLogin = LaunchAtLogin(service: MainAppLoginItem())

    init(paths: AppPaths = .current) {
        self.paths = paths
        let discovery = Discovery(tidegapHome: paths.tidegapHome)
        let launcher = ServerLauncher(
            runner: SystemProcessRunner(logURL: paths.serverLog),
            discovery: discovery,
            homeOverride: paths.homeOverride
        )
        controller = ConnectionController(
            store: TokenStore(directory: paths.support),
            discovery: discovery,
            launcher: launcher
        )
        let cursorKey = "cursor:" + paths.tidegapHome.path
        deriver = EventDeriver(cursor: UserDefaults.standard.string(forKey: cursorKey)) { cursor in
            UserDefaults.standard.set(cursor, forKey: cursorKey)
        }
        UserDefaults.standard.register(defaults: [SettingsKey.notifyFinished: true, SettingsKey.notifyCleanWindow: true])
        applySettings()
        controller.cursor = { [weak self] in self?.deriver.cursor }
        controller.onSummary = { [weak self] summary in self?.notify(summary) }
        controller.onChange = { [weak self] in self?.sync() }
    }

    /// Summary changes become notifications (U16). Asks for permission on
    /// the first connect.
    private func notify(_ summary: Summary) {
        if !askedForNotifications {
            askedForNotifications = true
            notifications.requestAuthorization()
        }
        let defaults = UserDefaults.standard
        let toggles = NotificationToggles(
            taskFinished: defaults.bool(forKey: SettingsKey.notifyFinished),
            cleanWindow: defaults.bool(forKey: SettingsKey.notifyCleanWindow)
        )
        for event in deriver.derive(summary, toggles: toggles) {
            notifications.deliver(event)
        }
    }

    /// Settings: the command override (argv text) and the port.
    func applySettings() {
        let defaults = UserDefaults.standard
        let command = defaults.string(forKey: SettingsKey.command) ?? ""
        let argv = CommandLineSplitter.split(command)
        controller.launcher.commandOverride = argv.isEmpty ? nil : argv
        let port = defaults.integer(forKey: SettingsKey.port)
        controller.launcher.port = (1...65535).contains(port) ? port : nil
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            await self?.controller.connect()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                await self?.controller.refresh()
            }
        }
    }

    func refresh() {
        Task { await controller.refresh() }
    }

    /// Applies Settings and connects again with the stored token.
    func retry() {
        applySettings()
        Task { await controller.connect() }
    }

    func showWindow() {
        viewRequest = nil
        onShowWindow()
    }

    /// Opens the page window on Settings → Integrations (KTD9).
    func showIntegrations() {
        viewRequestCount += 1
        viewRequest = PageViewRequest(view: .settings, id: viewRequestCount)
        onShowWindow()
    }

    func reconnect() {
        applySettings()
        Task { await controller.reconnect() }
    }

    func forgetToken() {
        controller.forgetToken()
    }

    /// Stops polling, the stream, and the child this app started (AE5).
    func shutdown() {
        pollTask?.cancel()
        stream?.stop()
        controller.shutdown()
    }

    /// The page URL with the client token in the fragment (U17).
    var pageURL: URL? { pageURL(view: nil) }

    /// The page URL that opens `view` first.
    func pageURL(view: PageView?) -> URL? {
        guard case .connected(let port, _) = state, let token = controller.token else { return nil }
        return Format.pageURL(port: port, token: token, view: view?.rawValue)
    }

    private func sync() {
        // Assign only changes: @Observable re-renders the status item on every set.
        if state != controller.state { state = controller.state }
        if summary != controller.summary { summary = controller.summary }
        updateStream()
    }

    /// One stream per (port, token); refetch on `tasks` and on `hello` after a drop.
    private func updateStream() {
        guard case .connected(let port, _) = state, let token = controller.token else {
            stream?.stop()
            stream = nil
            streamKey = nil
            return
        }
        let key = "\(port)|\(token)"
        guard key != streamKey else { return }
        stream?.stop()
        streamKey = key
        let stream = EventStream(port: port, token: token) { [weak self] signal in
            switch signal {
            case .hello(let reconnected):
                if reconnected { await self?.controller.refresh() }
            case .tasks, .unauthorized:
                await self?.controller.refresh()
            }
        }
        self.stream = stream
        stream.start()
    }
}

enum SettingsKey {
    static let command = "tidegapCommand"
    static let port = "port"
    static let notifyFinished = "notifyTaskFinished"
    static let notifyCleanWindow = "notifyCleanWindow"
}

/// Where the app reads and writes. `-home <dir>` (a launch argument) moves
/// all of it under `<dir>`, so a test run never touches the real ~/.tidegap.
struct AppPaths {
    var homeOverride: URL?
    var tidegapHome: URL
    var support: URL
    var serverLog: URL

    static var current: AppPaths {
        let fm = FileManager.default
        if let dir = UserDefaults.standard.string(forKey: "home"), !dir.isEmpty {
            let home = URL(fileURLWithPath: (dir as NSString).expandingTildeInPath, isDirectory: true)
            return AppPaths(
                homeOverride: home,
                tidegapHome: home.appendingPathComponent(".tidegap"),
                support: home.appendingPathComponent("Library/Application Support/Tidegap"),
                serverLog: home.appendingPathComponent("Library/Logs/Tidegap/tidegap-ui.log")
            )
        }
        let home = fm.homeDirectoryForCurrentUser
        let library = fm.urls(for: .libraryDirectory, in: .userDomainMask).first ?? home.appendingPathComponent("Library")
        return AppPaths(
            homeOverride: nil,
            tidegapHome: home.appendingPathComponent(".tidegap"),
            support: library.appendingPathComponent("Application Support/Tidegap"),
            serverLog: library.appendingPathComponent("Logs/Tidegap/tidegap-ui.log")
        )
    }
}

/// A page view the app can ask for (the page's `&view=` allow-list).
enum PageView: String {
    case settings
}

/// One request to show a view; `id` tells a repeated request from the last one.
struct PageViewRequest: Equatable {
    let view: PageView
    let id: Int
}
