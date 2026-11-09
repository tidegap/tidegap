import Foundation
import Testing
@testable import TidegapKit

@Suite struct PageRoutingTests {
    let link = URL(string: "http://127.0.0.1:47931/#token=abc")!
    let start = URL(string: "http://127.0.0.1:47931/#token=abc&view=settings")!
    let jobs = PageRouting.Request(id: 1, view: "jobs")
    let settings = PageRouting.Request(id: 2, view: "settings")

    /// A window that loaded its page link with no view asked for.
    func loaded() -> PageRouting {
        var routing = PageRouting()
        _ = routing.serverChanged(link: link, start: link, request: nil)
        _ = routing.finished(isErrorPage: false)
        return routing
    }

    @Test func theFirstLoadOpensTheStartLinkAndAppliesItsRequestOnce() {
        var routing = PageRouting()
        #expect(routing.serverChanged(link: link, start: start, request: settings) == [.load(start)])
        #expect(routing.server == link)
        #expect(routing.request(settings, isLoading: true) == [])
        #expect(routing.finished(isErrorPage: false) == [.setHash("settings", request: 2)])
        #expect(routing.hashResult(id: 2, .later) == [.report(2)])
        #expect(routing.finished(isErrorPage: false) == [])
    }

    @Test func aRequestOnALoadedPageSetsTheHashAndReportsOnce() {
        var routing = loaded()
        #expect(routing.request(jobs, isLoading: false) == [.setHash("jobs", request: 1)])
        #expect(routing.hashResult(id: 1, .set) == [.report(1)])
        #expect(routing.hashResult(id: 1, .set) == [])
        #expect(routing.request(jobs, isLoading: false) == [])
        #expect(routing.finished(isErrorPage: false) == [])
    }

    @Test func aRepeatedRequestWithANewIdSetsTheHashAgain() {
        var routing = loaded()
        _ = routing.request(jobs, isLoading: false)
        _ = routing.hashResult(id: 1, .set)
        let again = PageRouting.Request(id: 3, view: "jobs")
        #expect(routing.request(again, isLoading: false) == [.setHash("jobs", request: 3)])
        #expect(routing.hashResult(id: 3, .set) == [.report(3)])
    }

    @Test func aRequestDuringALoadWaitsForTheFinish() {
        var routing = loaded()
        #expect(routing.request(jobs, isLoading: true) == [])
        #expect(routing.finished(isErrorPage: false) == [.setHash("jobs", request: 1)])
        #expect(routing.hashResult(id: 1, .set) == [.report(1)])
    }

    @Test func noRequestDropsAWaitingOne() {
        var routing = loaded()
        _ = routing.request(jobs, isLoading: true)
        #expect(routing.request(nil, isLoading: true) == [])
        #expect(routing.finished(isErrorPage: false) == [])
    }

    @Test func aPortChangeKeepsTheRequestAndDropsTheRestoredView() {
        var routing = loaded()
        _ = routing.freshLink(restoring: "task/t-1")
        let moved = URL(string: "http://127.0.0.1:47932/#token=abc")!
        #expect(routing.serverChanged(link: moved, start: moved, request: jobs) == [.load(moved)])
        #expect(routing.failed(cancelled: true) == [])
        #expect(routing.request(jobs, isLoading: true) == [])
        #expect(routing.finished(isErrorPage: false) == [.setHash("jobs", request: 1)])
    }

    @Test func aCancelledLoadKeepsTheRequestAndAFailedOneReportsIt() {
        var routing = loaded()
        _ = routing.request(jobs, isLoading: true)
        #expect(routing.failed(cancelled: true) == [])
        #expect(routing.failed(cancelled: false) == [.report(1)])
        #expect(routing.finished(isErrorPage: false) == [])
    }

    @Test func aFreshLinkLoadsThePageLinkAndSetsTheRestoredViewOnce() {
        var routing = loaded()
        #expect(routing.freshLink(restoring: "task/t-1") == [.load(link)])
        #expect(routing.finished(isErrorPage: false) == [.setHash("task/t-1", request: nil)])
        #expect(routing.hashResult(id: nil, .set) == [])
        #expect(routing.finished(isErrorPage: false) == [])
    }

    @Test func aFailedFreshLinkDropsTheRestoredView() {
        var routing = loaded()
        _ = routing.freshLink(restoring: "task/t-1")
        #expect(routing.failed(cancelled: false) == [])
        #expect(routing.finished(isErrorPage: false) == [])
    }

    @Test func aPendingRequestWinsOverARestoredView() {
        var routing = loaded()
        _ = routing.freshLink(restoring: "task/t-1")
        _ = routing.request(jobs, isLoading: true)
        #expect(routing.finished(isErrorPage: false) == [.setHash("jobs", request: 1)])
        #expect(routing.hashResult(id: 1, .set) == [.report(1)])
        #expect(routing.finished(isErrorPage: false) == [])
    }

    @Test func aFailedScriptCallCountsAsSet() {
        var routing = loaded()
        _ = routing.request(jobs, isLoading: false)
        #expect(routing.hashResult(id: 1, nil) == [.report(1)])
    }

    /// #235 R1 (AE1): a fresh link differs from the loaded page only in its
    /// fragment, so WebKit does not mark the view as loading; the page sees
    /// `#token=` and reloads itself. A request in that gap must survive it.
    @Test func aRequestBeforeTheFreshLinkReloadsIsAppliedAfterTheReload() {
        var routing = loaded()
        _ = routing.request(jobs, isLoading: false)
        _ = routing.hashResult(id: 1, .set)
        #expect(routing.freshLink(restoring: "jobs") == [.load(link)])
        #expect(routing.request(settings, isLoading: false) == [])
        #expect(routing.finished(isErrorPage: false) == [.setHash("settings", request: 2)])
        #expect(routing.hashResult(id: 2, .later) == [.report(2)])
        #expect(routing.finished(isErrorPage: false) == [])
    }

    /// The page got a `#token=` link and reloads itself: the request waits for that load.
    @Test func aReloadResultKeepsTheRequestForTheReloadedPage() {
        var routing = loaded()
        #expect(routing.request(settings, isLoading: false) == [.setHash("settings", request: 2)])
        #expect(routing.hashResult(id: 2, .reload) == [])
        #expect(routing.finished(isErrorPage: false) == [.setHash("settings", request: 2)])
        #expect(routing.hashResult(id: 2, .set) == [.report(2)])
    }

    @Test func aFailedFreshLinkStopsTheWait() {
        var routing = loaded()
        _ = routing.freshLink(restoring: nil)
        _ = routing.failed(cancelled: false)
        #expect(routing.request(jobs, isLoading: false) == [.setHash("jobs", request: 1)])
    }

    /// An error page does not reload itself, so nothing waits for it to.
    @Test func anErrorPageEndsAPendingRequest() {
        var routing = PageRouting()
        _ = routing.serverChanged(link: link, start: start, request: settings)
        #expect(routing.finished(isErrorPage: true) == [.report(2)])
        #expect(routing.request(jobs, isLoading: false) == [.setHash("jobs", request: 1)])
        #expect(routing.hashResult(id: 1, .reload) == [.report(1)])
        _ = routing.freshLink(restoring: nil)
        let again = PageRouting.Request(id: 3, view: "jobs")
        #expect(routing.request(again, isLoading: false) == [.setHash("jobs", request: 3)])
    }

    /// #235 R3 (AE2): a fresh link that ends on a server error page.
    @Test func anErrorPageGetsNoRestoredViewAndALaterLoadOpensTheAgenda() {
        var routing = loaded()
        _ = routing.freshLink(restoring: "task/t-1")
        #expect(routing.finished(isErrorPage: true) == [])
        #expect(routing.finished(isErrorPage: false) == [])
    }
}
