import AppKit
import Observation
import SwiftUI
import TidegapKit

/// The menu bar item. A left click (or keyboard activation) toggles the page
/// window; a right click or ⌃-click opens the context menu. The title shows
/// only the queue (`Format.statusTitle`); the clean window and region live in
/// the tooltip and the window subtitle.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private let model: AppModel
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let launchAtLoginItem = NSMenuItem(title: "Launch at login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
    private var mainWindow: NSWindow?
    private var settingsWindow: NSWindow?

    init(model: AppModel) {
        self.model = model
        super.init()
        if let button = item.button {
            button.image = NSImage(named: "MenuBarIcon")
            button.imagePosition = .imageLeading
            button.setAccessibilityLabel("Tidegap")
            button.target = self
            button.action = #selector(clicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        buildMenu()
        observe()
    }

    // MARK: Status item

    @objc private func clicked() {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            showMenu()
        } else {
            toggleWindow()
        }
    }

    /// Re-renders the title, tooltip and subtitle on every state or summary change.
    private func observe() {
        withObservationTracking {
            render()
        } onChange: { [weak self] in
            Task { @MainActor in self?.observe() }
        }
    }

    private func render() {
        item.button?.title = Format.statusTitle(state: model.state, summary: model.summary)
        item.button?.toolTip = Format.tooltip(state: model.state, summary: model.summary)
        mainWindow?.subtitle = subtitle
    }

    /// "Clean 04:00-09:00 · US-MIDA-PJM · 0 active · 1 unread", or the connection state.
    private var subtitle: String {
        let headline = Format.headline(state: model.state, summary: model.summary)
        guard model.state.isConnected, let detail = Format.detail(state: model.state, summary: model.summary) else { return headline }
        return "\(headline) · \(detail)"
    }

    // MARK: Context menu

    private func buildMenu() {
        menu.delegate = self
        menu.addItem(NSMenuItem(title: "Open Tidegap", action: #selector(openTidegap), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Integrations…", action: #selector(openIntegrations), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ","))
        menu.addItem(.separator())
        menu.addItem(launchAtLoginItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Tidegap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for entry in menu.items where entry.action != #selector(NSApplication.terminate(_:)) {
            entry.target = self
        }
    }

    /// Attaching the menu only while it is open keeps a left click on the window toggle.
    private func showMenu() {
        model.launchAtLogin.refresh()
        launchAtLoginItem.state = model.launchAtLogin.isOn ? .on : .off
        item.menu = menu
        item.button?.performClick(nil)
    }

    func menuDidClose(_ menu: NSMenu) {
        item.menu = nil
    }

    @objc private func openTidegap() { model.showWindow() }
    @objc private func openIntegrations() { model.showIntegrations() }
    @objc private func toggleLaunchAtLogin() { model.launchAtLogin.set(!model.launchAtLogin.isOn) }

    // MARK: Windows

    /// Hides the page window when it is already in front, else shows it.
    func toggleWindow() {
        if let window = mainWindow, window.isVisible, window.isKeyWindow, NSApp.isActive {
            window.orderOut(nil)
        } else {
            model.showWindow()
        }
    }

    /// Shows the page window (`WebPageWindow`), creating it on first use.
    func showWindow() {
        let window = mainWindow ?? makeMainWindow()
        mainWindow = window
        bringToFront(window)
    }

    @objc func showSettings() {
        let window = settingsWindow ?? makeWindow(SettingsView(), title: "Tidegap Settings", resizable: false)
        settingsWindow = window
        bringToFront(window)
    }

    private func makeMainWindow() -> NSWindow {
        let window = makeWindow(WebPageWindow(), title: "Tidegap", resizable: true)
        window.setContentSize(NSSize(width: 1100, height: 760))
        window.center()
        window.setFrameAutosaveName("TidegapMain")
        window.subtitle = subtitle
        return window
    }

    private func makeWindow(_ content: some View, title: String, resizable: Bool) -> NSWindow {
        let host = NSHostingController(rootView: content.environment(model))
        let window = NSWindow(contentViewController: host)
        window.title = title
        window.styleMask = resizable ? [.titled, .closable, .miniaturizable, .resizable] : [.titled, .closable]
        window.isReleasedWhenClosed = false
        if !resizable { window.center() }
        return window
    }

    private func bringToFront(_ window: NSWindow) {
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }
}
