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
        addMissingEditMenus()
        model.onShowWindow = { [weak statusItem] in statusItem?.showWindow() }
        model.notifications.onOpen = { [model] in model.showWindow() }
        model.start()
        if CommandLine.arguments.contains("--show-window") { model.showWindow() }
    }

    /// Quit or SIGTERM stops only the server this app started (AE5).
    @MainActor func applicationWillTerminate(_ notification: Notification) {
        model.shutdown()
    }

    /// The edit and close keys (Cmd-C, Cmd-V, Cmd-Z, Cmd-W…) act only through
    /// main menu items, and SwiftUI may build none for this app. So an Edit
    /// menu and a Window menu with Close are added when their actions are
    /// missing. The menu bar never shows (LSUIElement); only the keys act. A
    /// nil target lets the responder chain route each action to the key window.
    @MainActor private func addMissingEditMenus() {
        let main = NSApp.mainMenu ?? NSMenu()
        if !main.contains(action: #selector(NSText.copy(_:))) {
            let edit = NSMenu(title: "Edit")
            edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
            edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
            edit.addItem(.separator())
            edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
            edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
            edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
            edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
            main.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit
        }
        if !main.contains(action: #selector(NSWindow.performClose(_:))) {
            let window = NSMenu(title: "Window")
            window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
            main.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = window
        }
        NSApp.mainMenu = main
    }
}

private extension NSMenu {
    /// True when this menu or one of its submenus has an item for `action`.
    func contains(action: Selector) -> Bool {
        items.contains { $0.action == action || $0.submenu?.contains(action: action) == true }
    }
}
