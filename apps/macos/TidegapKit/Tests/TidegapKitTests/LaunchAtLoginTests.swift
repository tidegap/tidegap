import Foundation
import Testing
@testable import TidegapKit

final class FakeLoginItem: LoginItemService {
    var status: LoginItemStatus
    var error: Error?
    /// The status a successful call leaves; a failed call leaves `status` as it is.
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
}

@MainActor
@Suite struct LaunchAtLoginTests {
    struct Denied: LocalizedError {
        var errorDescription: String? { "Operation not permitted" }
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

    @Test func refreshPicksUpSystemSettingsChange() {
        let service = FakeLoginItem(status: .enabled)
        let toggle = LaunchAtLogin(service: service)
        #expect(toggle.isOn)
        service.status = .notRegistered
        toggle.refresh()
        #expect(!toggle.isOn)
    }
}
