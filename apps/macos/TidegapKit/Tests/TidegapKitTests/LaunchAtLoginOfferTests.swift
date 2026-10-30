import Foundation
import Testing
@testable import TidegapKit

/// The offer's "answered" flag lives in a local object here, never in a
/// defaults domain.
@MainActor
@Suite struct LaunchAtLoginOfferTests {
    final class Flag {
        var value = false
        var writes = 0
    }

    func makeOffer(_ service: FakeLoginItem, _ flag: Flag, isolated: Bool = false) -> LaunchAtLoginOffer {
        LaunchAtLoginOffer(
            launchAtLogin: LaunchAtLogin(service: service),
            isolated: isolated,
            isAnswered: { flag.value },
            markAnswered: {
                flag.value = true
                flag.writes += 1
            }
        )
    }

    @Test func offerIsDueOnceAndLaunchAtLoginRegisters() {
        let service = FakeLoginItem(status: .notRegistered)
        let flag = Flag()
        let offer = makeOffer(service, flag)
        #expect(offer.isDue())
        #expect(!flag.value)
        #expect(offer.answer(.launchAtLogin) == .enabled)
        #expect(service.calls == ["register"])
        #expect(flag.value)
        #expect(!offer.isDue())
        #expect(!makeOffer(service, flag).isDue())
    }

    @Test func notNowRecordsTheAnswerAndCallsNothing() {
        let service = FakeLoginItem(status: .notRegistered)
        let flag = Flag()
        let offer = makeOffer(service, flag)
        #expect(offer.isDue())
        #expect(offer.answer(.notNow) == .declined)
        #expect(service.calls.isEmpty)
        #expect(flag.value)
        #expect(!offer.isDue())
    }

    @Test func enabledAtLaunchRecordsTheOfferWithoutAsking() {
        let service = FakeLoginItem(status: .enabled)
        let flag = Flag()
        #expect(!makeOffer(service, flag).isDue())
        #expect(flag.value)
        #expect(service.calls.isEmpty)
    }

    @Test func requiresApprovalAtLaunchRecordsTheOfferWithoutAsking() {
        let service = FakeLoginItem(status: .requiresApproval)
        let flag = Flag()
        #expect(!makeOffer(service, flag).isDue())
        #expect(flag.value)
        #expect(service.calls.isEmpty)
    }

    @Test func notFoundAtLaunchIsOffered() {
        let service = FakeLoginItem(status: .notFound)
        let flag = Flag()
        #expect(makeOffer(service, flag).isDue())
        #expect(!flag.value)
    }

    @Test func refusedRegisterReturnsTheReasonAndStillRecords() {
        let service = FakeLoginItem(status: .notRegistered)
        service.error = LaunchAtLoginTests.Denied()
        let flag = Flag()
        let offer = makeOffer(service, flag)
        #expect(offer.isDue())
        #expect(offer.answer(.launchAtLogin) == .failed("Could not turn launch at login on: Operation not permitted"))
        #expect(flag.value)
    }

    @Test func registerThatEndsInApprovalReturnsNeedsApproval() {
        let service = FakeLoginItem(status: .notRegistered)
        service.statusAfterRegister = .requiresApproval
        let flag = Flag()
        let offer = makeOffer(service, flag)
        #expect(offer.isDue())
        #expect(offer.answer(.launchAtLogin) == .needsApproval)
        #expect(service.calls == ["register"])
        #expect(flag.value)
    }

    @Test func isolatedLaunchNeverOffersNorWrites() {
        for status: LoginItemStatus in [.enabled, .notRegistered, .requiresApproval, .notFound] {
            let service = FakeLoginItem(status: status)
            let flag = Flag()
            #expect(!makeOffer(service, flag, isolated: true).isDue())
            #expect(flag.writes == 0)
            #expect(service.calls.isEmpty)
        }
    }

    @Test func answeredFlagStopsTheOffer() {
        for status: LoginItemStatus in [.enabled, .notRegistered, .requiresApproval, .notFound] {
            let flag = Flag()
            flag.value = true
            #expect(!makeOffer(FakeLoginItem(status: status), flag).isDue())
            #expect(flag.writes == 0)
        }
    }
}
