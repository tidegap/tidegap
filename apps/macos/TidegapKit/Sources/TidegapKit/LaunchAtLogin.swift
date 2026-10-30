import Foundation
import Observation
import ServiceManagement

/// The login item state, as `SMAppService.Status` reports it.
public enum LoginItemStatus: Sendable, Equatable {
    case enabled
    case notRegistered
    /// Registered, but turned off in System Settings > General > Login Items.
    case requiresApproval
    case notFound

    /// One value per system status; a value this build does not know reads
    /// as `notRegistered`.
    public init(_ status: SMAppService.Status) {
        switch status {
        case .enabled: self = .enabled
        case .requiresApproval: self = .requiresApproval
        case .notFound: self = .notFound
        case .notRegistered: self = .notRegistered
        @unknown default: self = .notRegistered
        }
    }
}

/// The login item calls the toggle and the menu item need.
/// `MainAppLoginItem` is the real one; tests pass a fake.
public protocol LoginItemService {
    var status: LoginItemStatus { get }
    func register() throws
    func unregister() throws
    /// Opens System Settings > General > Login Items.
    func openSystemSettings()
}

/// `SMAppService.mainApp`: this app as its own login item (macOS 13+).
public struct MainAppLoginItem: LoginItemService {
    public init() {}

    public var status: LoginItemStatus { LoginItemStatus(SMAppService.mainApp.status) }

    public func register() throws { try SMAppService.mainApp.register() }
    public func unregister() throws { try SMAppService.mainApp.unregister() }
    public func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}

/// The "Launch at login" toggle in Settings and the right-click menu item.
/// Off until the user turns it on; it reads the system state, so a change in
/// System Settings shows here.
@MainActor
@Observable
public final class LaunchAtLogin {
    public static let approvalHint = "Turned off in System Settings. Turn Tidegap on under General > Login Items."

    public private(set) var isOn = false
    public private(set) var status: LoginItemStatus = .notRegistered
    /// One line under the toggle: the approval hint or the last error.
    public private(set) var message: String?

    @ObservationIgnored private let service: LoginItemService

    public init(service: LoginItemService) {
        self.service = service
        refresh()
    }

    /// Re-reads the system state. Settings calls it when it opens and when
    /// the app becomes active; the menu calls it when it opens.
    public func refresh() {
        status = service.status
        isOn = status == .enabled
        message = status == .requiresApproval ? Self.approvalHint : nil
    }

    /// Registers or unregisters the app. When the system state does not
    /// follow, the toggle goes back to it and `message` says why.
    public func set(_ on: Bool) {
        guard on != isOn else { return }
        do {
            if on { try service.register() } else { try service.unregister() }
            refresh()
            if isOn != on, message == nil {
                message = "Launch at login is still \(isOn ? "on" : "off"). Check General > Login Items in System Settings."
            }
        } catch {
            refresh()
            if message == nil {
                message = "Could not turn launch at login \(on ? "on" : "off"): \(error.localizedDescription)"
            }
        }
    }

    public func openSystemSettings() { service.openSystemSettings() }

    /// The right-click menu item's title; it names a needed approval.
    public var menuTitle: String {
        status == .requiresApproval ? "Launch at login (needs approval)" : "Launch at login"
    }

    /// A click on the right-click menu item. It re-reads the state first.
    /// Needs approval: opens System Settings > Login Items and calls nothing
    /// else, since the system refuses `register()` in that state. Otherwise
    /// it toggles. Returns the line to show (the approval hint or why the
    /// call failed), or nil when there is nothing to show.
    public func menuClick() -> String? {
        refresh()
        if status == .requiresApproval {
            openSystemSettings()
            return nil
        }
        set(!isOn)
        return message
    }
}

/// The two answers to the launch-at-login offer.
public enum OfferChoice: Sendable {
    case launchAtLogin
    case notNow
}

/// What an answer to the offer led to; the app shows a follow-up only for
/// `needsApproval` and `failed`.
public enum OfferOutcome: Sendable, Equatable {
    case enabled
    case needsApproval
    case declined
    /// The line that says why launch at login did not turn on.
    case failed(String)
}

/// The one-time launch-at-login offer at app launch. The app keeps the
/// "answered" flag; this type decides when to ask and what an answer does.
@MainActor
public final class LaunchAtLoginOffer {
    private let launchAtLogin: LaunchAtLogin
    private let isolated: Bool
    private let isAnswered: () -> Bool
    private let markAnswered: () -> Void

    /// `isolated`: a `-home` run, which never offers and never writes the flag.
    public init(
        launchAtLogin: LaunchAtLogin,
        isolated: Bool,
        isAnswered: @escaping () -> Bool,
        markAnswered: @escaping () -> Void
    ) {
        self.launchAtLogin = launchAtLogin
        self.isolated = isolated
        self.isAnswered = isAnswered
        self.markAnswered = markAnswered
    }

    /// True when the app should ask now. An item that is on, or turned off
    /// in System Settings, records the offer as answered without asking.
    public func isDue() -> Bool {
        guard !isolated, !isAnswered() else { return false }
        launchAtLogin.refresh()
        switch launchAtLogin.status {
        case .enabled, .requiresApproval:
            markAnswered()
            return false
        case .notRegistered, .notFound:
            return true
        }
    }

    /// Records the answer first, so the app never asks again, then acts on it.
    public func answer(_ choice: OfferChoice) -> OfferOutcome {
        markAnswered()
        guard choice == .launchAtLogin else { return .declined }
        launchAtLogin.refresh()
        launchAtLogin.set(true)
        switch launchAtLogin.status {
        case .enabled: return .enabled
        case .requiresApproval: return .needsApproval
        case .notRegistered, .notFound:
            return .failed(launchAtLogin.message ?? "Could not turn launch at login on.")
        }
    }
}
