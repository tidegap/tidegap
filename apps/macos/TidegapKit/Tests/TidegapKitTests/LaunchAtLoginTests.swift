import Foundation
import ServiceManagement
import Testing
@testable import TidegapKit

final class FakeLoginItem: LoginItemService {
    var status: LoginItemStatus
    var error: Error?
    /// The status a successful `register()` leaves.
    var statusAfterRegister: LoginItemStatus = .enabled
    private(set) var calls: [String] = []

    init(status: LoginItemStatus = .notRegistered) { self.status = status }

    func register() throws {
        calls.append("register")
        if let error { throw error }
        status = statusAfterRegister
    }

    func unregister() throws {
        calls.append("unregister")
        if let error { throw error }
        status = .notRegistered
    }

    func openSystemSettings() {
        calls.append("openSettings")
    }
}

@MainActor
@Suite struct LaunchAtLoginTests {
    struct Denied: LocalizedError {
        var errorDescription: String? { "Operation not permitted" }
    }

    struct Busy: LocalizedError {
        var errorDescription: String? { "Resource busy" }
    }

    @Test func defaultsOffAndRegistersOnToggle() {
        let service = FakeLoginItem()
        let toggle = LaunchAtLogin(service: service)
        #expect(!toggle.isOn)
        toggle.set(true)
        #expect(service.calls == ["register"])
        #expect(toggle.isOn)
        #expect(toggle.message == nil)
        toggle.set(false)
        #expect(service.calls == ["register", "unregister"])
        #expect(!toggle.isOn)
    }

    @Test func failureRevertsAndSaysWhy() {
        let service = FakeLoginItem()
        service.error = Denied()
        let toggle = LaunchAtLogin(service: service)
        toggle.set(true)
        #expect(!toggle.isOn)
        #expect(toggle.message == "Could not turn launch at login on: Operation not permitted")
    }

    @Test func requiresApprovalShowsHint() {
        let toggle = LaunchAtLogin(service: FakeLoginItem(status: .requiresApproval))
        #expect(!toggle.isOn)
        #expect(toggle.message == LaunchAtLogin.approvalHint)
    }

    @Test func refusedRegisterInApprovalStateKeepsHint() {
        let service = FakeLoginItem(status: .requiresApproval)
        service.error = Denied()
        let toggle = LaunchAtLogin(service: service)
        toggle.set(true)
        #expect(!toggle.isOn)
        #expect(toggle.message == LaunchAtLogin.approvalHint)
    }

    // MARK: The failure line across a refresh (KTD12)

    @Test func failureLineOutlivesARefreshUntilTheStatusChanges() {
        let service = FakeLoginItem()
        service.error = Denied()
        let toggle = LaunchAtLogin(service: service)
        toggle.set(true)
        let line = "Could not turn launch at login on: Operation not permitted"
        #expect(toggle.message == line)
        // The app becomes active again with nothing changed.
        toggle.refresh()
        #expect(toggle.message == line)
        service.status = .enabled
        toggle.refresh()
        #expect(toggle.message == nil)
        service.status = .notRegistered
        toggle.refresh()
        #expect(toggle.message == nil)
    }

    @Test func secondFailedToggleShowsItsOwnReason() {
        let service = FakeLoginItem()
        service.error = Denied()
        let toggle = LaunchAtLogin(service: service)
        toggle.set(true)
        service.error = Busy()
        toggle.set(true)
        #expect(toggle.message == "Could not turn launch at login on: Resource busy")
    }

    @Test func menuClickAfterAFailedToggleReturnsOnlyItsOwnOutcome() {
        let service = FakeLoginItem()
        service.error = Denied()
        let toggle = LaunchAtLogin(service: service)
        toggle.set(true)
        service.error = Busy()
        #expect(toggle.menuClick() == "Could not turn launch at login on: Resource busy")
        service.error = nil
        #expect(toggle.menuClick() == nil)
        #expect(toggle.isOn)
        #expect(toggle.message == nil)
    }

    @Test func approvalHintStillFollowsTheStatus() {
        let service = FakeLoginItem()
        service.error = Denied()
        let toggle = LaunchAtLogin(service: service)
        toggle.set(true)
        service.status = .requiresApproval
        toggle.refresh()
        #expect(toggle.message == LaunchAtLogin.approvalHint)
        service.status = .notRegistered
        toggle.refresh()
        #expect(toggle.message == nil)
        service.status = .requiresApproval
        toggle.refresh()
        #expect(toggle.message == LaunchAtLogin.approvalHint)
        service.status = .enabled
        toggle.refresh()
        #expect(toggle.message == nil)
    }

    @Test func refreshPicksUpSystemSettingsChange() {
        let service = FakeLoginItem(status: .enabled)
        let toggle = LaunchAtLogin(service: service)
        #expect(toggle.isOn)
        service.status = .notRegistered
        toggle.refresh()
        #expect(!toggle.isOn)
    }

    /// The only test that names `SMAppService`: no other test reaches the
    /// real login items.
    @Test func statusMapsEverySystemValue() throws {
        #expect(LoginItemStatus(SMAppService.Status.enabled) == .enabled)
        #expect(LoginItemStatus(SMAppService.Status.notRegistered) == .notRegistered)
        #expect(LoginItemStatus(SMAppService.Status.requiresApproval) == .requiresApproval)
        #expect(LoginItemStatus(SMAppService.Status.notFound) == .notFound)
        let unknown = try #require(SMAppService.Status(rawValue: 99))
        #expect(LoginItemStatus(unknown) == .notRegistered)
    }

    @Test func openSystemSettingsGoesThroughTheService() {
        let service = FakeLoginItem()
        LaunchAtLogin(service: service).openSystemSettings()
        #expect(service.calls == ["openSettings"])
    }

    @Test func menuTitlePerStatus() {
        for status: LoginItemStatus in [.enabled, .notRegistered, .notFound] {
            #expect(LaunchAtLogin(service: FakeLoginItem(status: status)).menuTitle == "Launch at login")
        }
        #expect(LaunchAtLogin(service: FakeLoginItem(status: .requiresApproval)).menuTitle == "Launch at login (needs approval)")
    }

    @Test func menuClickInApprovalOpensSystemSettingsOnly() {
        let service = FakeLoginItem(status: .requiresApproval)
        let toggle = LaunchAtLogin(service: service)
        #expect(toggle.menuClick() == nil)
        #expect(service.calls == ["openSettings"])
    }

    @Test func menuClickRegistersAndUnregisters() {
        for status: LoginItemStatus in [.notRegistered, .notFound] {
            let service = FakeLoginItem(status: status)
            let toggle = LaunchAtLogin(service: service)
            #expect(toggle.menuClick() == nil)
            #expect(service.calls == ["register"])
            #expect(toggle.isOn)
        }
        let service = FakeLoginItem(status: .enabled)
        let toggle = LaunchAtLogin(service: service)
        #expect(toggle.menuClick() == nil)
        #expect(service.calls == ["unregister"])
        #expect(!toggle.isOn)
    }

    @Test func menuClickReadsTheStateFirst() {
        let service = FakeLoginItem(status: .notRegistered)
        let toggle = LaunchAtLogin(service: service)
        service.status = .enabled
        #expect(toggle.menuClick() == nil)
        #expect(service.calls == ["unregister"])
    }

    @Test func menuClickRefusedReturnsTheReason() {
        let service = FakeLoginItem()
        service.error = Denied()
        let toggle = LaunchAtLogin(service: service)
        #expect(toggle.menuClick() == "Could not turn launch at login on: Operation not permitted")
        #expect(!toggle.isOn)
    }

    @Test func menuClickThatEndsInApprovalReturnsTheHint() {
        let service = FakeLoginItem()
        service.statusAfterRegister = .requiresApproval
        let toggle = LaunchAtLogin(service: service)
        #expect(toggle.menuClick() == LaunchAtLogin.approvalHint)
        #expect(service.calls == ["register"])
        #expect(toggle.menuTitle == "Launch at login (needs approval)")
    }

    @Test func registerThatLeavesTheItemOffSaysSo() {
        let service = FakeLoginItem()
        service.statusAfterRegister = .notRegistered
        let toggle = LaunchAtLogin(service: service)
        #expect(toggle.menuClick() == "Launch at login is still off. Check General > Login Items in System Settings.")
        #expect(!toggle.isOn)
    }
}
