import Foundation
import Testing
@testable import TidegapKit

@Suite struct PageLoadTests {
    @Test func onlyACancelledURLLoadCounts() {
        #expect(PageLoad.isCancelled(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
        #expect(PageLoad.isCancelled(URLError(.cancelled)))
        #expect(!PageLoad.isCancelled(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)))
        #expect(!PageLoad.isCancelled(NSError(domain: "WebKitErrorDomain", code: NSURLErrorCancelled)))
    }
}
