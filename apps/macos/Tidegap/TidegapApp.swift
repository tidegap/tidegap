import AppKit
import SwiftUI
import TidegapKit

/// The menu bar item and its windows are AppKit (`StatusItemController`): a
/// SwiftUI `MenuBarExtra` cannot open a window on a left click. The one scene
/// is an extra that is never inserted, so SwiftUI adds no Settings menu item.
@main
struct TidegapApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra("Tidegap", isInserted: .constant(false)) { EmptyView() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor let model = AppModel()
    @MainActor private var statusItem: StatusItemController?
    @MainActor private var termination: TerminationSignals?

    @MainActor func applicationDidFinishLaunching(_ notification: Notification) {
        // SIGTERM (`killall Tidegap`) quits like Quit, so the server this app
        // started stops too (applicationWillTerminate).
        termination = TerminationSignals([SIGTERM], queue: .main) {
            MainActor.assumeIsolated { NSApp.terminate(nil) }
        }
        let statusItem = StatusItemController(model: model)
        self.statusItem = statusItem
        model.onShowWindow = { [weak statusItem] in statusItem?.showWindow() }
        model.notifications.onOpen = { [model] in model.showWindow() }
        model.start()
        if CommandLine.arguments.contains("--show-window") { model.showWindow() }
    }

    /// Quit or SIGTERM stops only the server this app started (AE5).
    @MainActor func applicationWillTerminate(_ notification: Notification) {
        model.shutdown()
    }
}
