import Foundation
import Testing
@testable import TidegapKit

@Suite struct PageReloadTests {
    let server = URL(string: "http://127.0.0.1:47821/#token=tgc_live")!

    func url(_ text: String) -> URL { URL(string: text)! }

    @Test func aReloadOfTheServerWithoutATokenGetsAFreshLink() {
        let journal = url("http://127.0.0.1:47821/#/journal")
        #expect(PageReload.replacesReload(of: journal, isReload: true, server: server))
        #expect(PageReload.restoredView(journal) == "journal")
        // The bare server address, as after a load that never set a view: replaced, nothing to restore.
        let bare = url("http://127.0.0.1:47821/")
        #expect(PageReload.replacesReload(of: bare, isReload: true, server: server))
        #expect(PageReload.restoredView(bare) == nil)
    }

    @Test func thePagesOwnReloadAfterANewLinkGoesThrough() {
        #expect(!PageReload.replacesReload(of: url("http://127.0.0.1:47821/#token=tgc_x"), isReload: true, server: server))
    }

    @Test func otherNavigationsToTheServerGoThrough() {
        #expect(!PageReload.replacesReload(of: url("http://127.0.0.1:47821/#/journal"), isReload: false, server: server))
        #expect(!PageReload.replacesReload(of: url("http://127.0.0.1:47821/"), isReload: false, server: server))
    }

    @Test func anotherPortOrHostIsNotTheServer() {
        for other in ["http://127.0.0.1:47822/#/journal", "http://localhost:47821/#/journal", "https://127.0.0.1:47821/#/journal"] {
            #expect(!PageReload.isServer(url(other), server: server))
            #expect(!PageReload.replacesReload(of: url(other), isReload: true, server: server))
        }
        #expect(PageReload.isServer(url("http://127.0.0.1:47821/app.js"), server: server))
        #expect(!PageReload.isServer(url("http://127.0.0.1:47821/"), server: nil))
        #expect(!PageReload.isServer(nil, server: server))
    }

    @Test func restoredViewKeepsOnlySafePageAddresses() {
        #expect(PageReload.restoredView(url("http://127.0.0.1:47821/#/task/t-1")) == "task/t-1")
        #expect(PageReload.restoredView(url("http://127.0.0.1:47821/#/journal?status=failed")) == "journal?status=failed")
        #expect(PageReload.restoredView(url("http://127.0.0.1:47821/#/jobs/job_1~a.b,c&x=1")) == "jobs/job_1~a.b,c&x=1")
        for bad in ["#/x'y", "#/x%22y", "#/x%5Cy", "#/x%3Cy%3E", "#/a%20b", "#/", "", "#token=tgc_x", "#journal"] {
            #expect(PageReload.restoredView(url("http://127.0.0.1:47821/\(bad)")) == nil, "\(bad)")
        }
        #expect(PageReload.restoredView(url("http://127.0.0.1:47821/#/" + String(repeating: "a", count: PageReload.maxViewLength))) != nil)
        #expect(PageReload.restoredView(url("http://127.0.0.1:47821/#/" + String(repeating: "a", count: PageReload.maxViewLength + 1))) == nil)
        #expect(PageReload.restoredView(nil) == nil)
    }

    @Test func onlyTheExactExpiredStringFromTheServersMainFrameCounts() {
        func accepts(_ body: Any, mainFrame: Bool = true, scheme: String = "http", host: String = "127.0.0.1", port: Int = 47821) -> Bool {
            PageReload.isExpiredMessage(body, isMainFrame: mainFrame, scheme: scheme, host: host, port: port, server: server)
        }
        #expect(accepts("expired"))
        #expect(!accepts("expired", mainFrame: false))
        #expect(!accepts("expired", port: 47822))
        #expect(!accepts("expired", host: "localhost"))
        #expect(!accepts("expired", scheme: "https"))
        #expect(!accepts([String: Any]()))
        #expect(!accepts(NSDictionary()))
        #expect(!accepts("expired "))
        #expect(!PageReload.isExpiredMessage("expired", isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 47821, server: nil))
    }

    @Test func expiredReloadsAtMostOncePer30Seconds() {
        var now = Date(timeIntervalSince1970: 1_000_000)
        var guard_ = PageReload.Guard(now: { now })
        guard_.freshLinkLoaded()
        now += 40
        #expect(guard_.answer() == .freshLink)
        guard_.freshLinkLoaded()
        now += 5
        #expect(guard_.answer() == .checkConnection)
        now += 35
        #expect(guard_.answer() == .freshLink)
    }

    @Test func theGuardBoundaryIs30SecondsExactly() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        var now = start
        var guard_ = PageReload.Guard(now: { now })
        guard_.freshLinkLoaded()
        now = start + 29.5
        #expect(guard_.answer() == .checkConnection)
        now = start + PageReload.Guard.interval
        #expect(guard_.answer() == .freshLink)
    }

    @Test func expiredBeforeAnyFreshLinkReloads() {
        let guard_ = PageReload.Guard(now: Date.init)
        #expect(guard_.answer() == .freshLink)
    }
}
