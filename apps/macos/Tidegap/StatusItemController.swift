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
    private let jobsItem = NSMenuItem(title: "Jobs", action: nil, keyEquivalent: "")
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
        menu.addItem(ownItem("Open Tidegap", #selector(openTidegap)))
        jobsItem.isHidden = true
        menu.addItem(jobsItem)
        menu.addItem(ownItem("Integrations…", #selector(openIntegrations)))
        menu.addItem(ownItem("Settings…", #selector(showSettings), key: ","))
        menu.addItem(.separator())
        launchAtLoginItem.target = self
        menu.addItem(launchAtLoginItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Tidegap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func ownItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        return entry
    }

    /// Attaching the menu only while it is open keeps a left click on the window toggle.
    private func showMenu() {
        model.launchAtLogin.refresh()
        launchAtLoginItem.title = model.launchAtLogin.menuTitle
        launchAtLoginItem.state = model.launchAtLogin.isOn ? .on : .off
        updateJobsMenu()
        item.menu = menu
        item.button?.performClick(nil)
    }

    func menuDidClose(_ menu: NSMenu) {
        item.menu = nil
    }

    // MARK: Jobs

    /// The Jobs submenu: one item per job (title, then next and last run),
    /// each with its actions; hidden while not connected or when the server
    /// predates jobs.
    private func updateJobsMenu() {
        jobsItem.isHidden = !(model.state.isConnected && model.jobsSupported)
        guard !jobsItem.isHidden else { return }
        let submenu = NSMenu()
        if model.jobs.isEmpty {
            submenu.addItem(disabledItem("No jobs"))
        }
        let now = Date()
        for job in model.jobs {
            submenu.addItem(jobItem(job, now: now))
        }
        submenu.addItem(.separator())
        submenu.addItem(ownItem("New job on page…", #selector(newJob)))
        jobsItem.submenu = submenu
    }

    private func jobItem(_ job: Job, now: Date) -> NSMenuItem {
        let entry = NSMenuItem(title: Format.middleTruncate(oneLine(job.label)), action: nil, keyEquivalent: "")
        let line = Format.jobLine(job, now: now)
        entry.attributedTitle = twoLines(entry.title, line)
        entry.toolTip = [job.guarantee, job.lastRun?.preview].compactMap { $0 }.joined(separator: "\n")
        let actions = NSMenu()
        if job.canRunNow { actions.addItem(jobAction("Run now", #selector(runJobNow), job)) }
        if job.canPause { actions.addItem(jobAction("Pause", #selector(pauseJob), job)) }
        if job.canResume { actions.addItem(jobAction("Resume", #selector(resumeJob), job)) }
        if let preview = job.lastRun?.preview, !preview.isEmpty {
            if !actions.items.isEmpty { actions.addItem(.separator()) }
            actions.addItem(disabledItem("Last: " + Format.middleTruncate(oneLine(preview), limit: 60)))
        }
        if job.canEdit {
            if !actions.items.isEmpty { actions.addItem(.separator()) }
            actions.addItem(jobAction("Edit on page…", #selector(editJob), job))
        }
        entry.submenu = actions.items.isEmpty ? nil : actions
        return entry
    }

    /// Server text on one menu line: line breaks become spaces.
    private func oneLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        entry.isEnabled = false
        return entry
    }

    /// The title in the menu font, the detail line under it, smaller and grey.
    private func twoLines(_ title: String, _ detail: String) -> NSAttributedString {
        let text = NSMutableAttributedString(string: title, attributes: [.font: NSFont.menuFont(ofSize: 0)])
        text.append(NSAttributedString(string: "\n" + detail, attributes: [
            .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]))
        return text
    }

    private func jobAction(_ title: String, _ action: Selector, _ job: Job) -> NSMenuItem {
        let entry = ownItem(title, action)
        entry.representedObject = job.jobId
        return entry
    }

    @objc private func runJobNow(_ sender: NSMenuItem) { perform(.runNow, sender) }
    @objc private func pauseJob(_ sender: NSMenuItem) { perform(.pause, sender) }
    @objc private func resumeJob(_ sender: NSMenuItem) { perform(.resume, sender) }

    @objc private func editJob(_ sender: NSMenuItem) {
        guard let jobId = sender.representedObject as? String else { return }
        model.showJob(jobId)
    }

    @objc private func newJob() { model.showNewJob() }

    /// One action per click; a refusal shows the server's sentence.
    private func perform(_ action: JobAction, _ sender: NSMenuItem) {
        guard let jobId = sender.representedObject as? String else { return }
        Task { @MainActor [model] in
            guard let message = await model.perform(action, jobId: jobId) else { return }
            let alert = NSAlert()
            alert.messageText = message
            alert.alertStyle = .warning
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    @objc private func openTidegap() { model.showWindow() }
    @objc private func openIntegrations() { model.showIntegrations() }

    /// A click never fails silently (KTD2, KTD5): a refused call shows its
    /// reason; a needed approval shows the hint with "Open Login Items".
    @objc private func toggleLaunchAtLogin() {
        let launchAtLogin = model.launchAtLogin
        guard let line = launchAtLogin.menuClick() else { return }
        let needsApproval = launchAtLogin.status == .requiresApproval
        Task { @MainActor in
            let alert = NSAlert()
            alert.messageText = line
            alert.alertStyle = .warning
            if needsApproval {
                alert.addButton(withTitle: "Open Login Items")
                alert.addButton(withTitle: "OK").keyEquivalent = "\u{1b}"
            }
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn, needsApproval {
                launchAtLogin.openSystemSettings()
            }
        }
    }

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
        // A reused window does not fire `onAppear`; the toggle must match System Settings.
        model.launchAtLogin.refresh()
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
