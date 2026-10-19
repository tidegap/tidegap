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
}

/// The login item calls the Settings toggle needs. `MainAppLoginItem` is
/// the real one; tests pass a fake.
public protocol LoginItemService {
    var status: LoginItemStatus { get }
    func register() throws
    func unregister() throws
}

/// `SMAppService.mainApp`: this app as its own login item (macOS 13+).
public struct MainAppLoginItem: LoginItemService {
    public init() {}

    public var status: LoginItemStatus {
        switch SMAppService.mainApp.status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        default: return .notRegistered
        }
    }

    public func register() throws { try SMAppService.mainApp.register() }
    public func unregister() throws { try SMAppService.mainApp.unregister() }
}

/// The "Launch at login" toggle in Settings. Off until the user turns it on;
/// it reads the system state, so a change in System Settings shows here.
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

    /// Re-reads the system state. Settings calls it when it opens.
    public func refresh() {
        status = service.status
        isOn = status == .enabled
        message = status == .requiresApproval ? Self.approvalHint : nil
    }

    /// Registers or unregisters the app. On failure the toggle goes back to
    /// the system state and `message` says why.
    public func set(_ on: Bool) {
        guard on != isOn else { return }
        do {
            if on { try service.register() } else { try service.unregister() }
            refresh()
        } catch {
            refresh()
            if message == nil {
                message = "Could not turn launch at login \(on ? "on" : "off"): \(error.localizedDescription)"
            }
        }
    }
}
