import Foundation
import Testing
@testable import TidegapKit

/// Signal handling is process-wide, so these tests run one at a time. Each
/// sends SIGUSR1 only while a helper is installed: its default action ends
/// the test process.
@Suite(.serialized) struct TerminationSignalsTests {
    /// The handler calls; each records whether it ran on the test's queue.
    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [Bool] = []

        func record(onQueue: Bool) { lock.withLock { calls.append(onQueue) } }
        var all: [Bool] { lock.withLock { calls } }

        /// Polls until `count` calls arrived; false after 2 s.
        func wait(for count: Int) async -> Bool {
            let deadline = Date().addingTimeInterval(2)
            while all.count < count {
                if Date() >= deadline { return false }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
            return true
        }
    }

    /// The action of `sig` as a raw value: 0 is SIG_DFL, 1 is SIG_IGN.
    func action(_ sig: Int32) -> Int {
        var current = sigaction()
        sigaction(sig, nil, &current)
        return unsafeBitCast(current.__sigaction_u.__sa_handler, to: Int.self)
    }

    @Test func signalRunsTheClosureOnTheQueueAndTheProcessLives() async {
        let queue = DispatchQueue(label: "termination-signals-test")
        let key = DispatchSpecificKey<Bool>()
        queue.setSpecific(key: key, value: true)
        let calls = Calls()
        let helper = TerminationSignals([SIGUSR1], queue: queue) {
            calls.record(onQueue: DispatchQueue.getSpecific(key: key) == true)
        }
        defer { helper.cancel() }
        #expect(action(SIGUSR1) == 1)
        kill(getpid(), SIGUSR1)
        #expect(await calls.wait(for: 1))
        queue.sync {}
        #expect(calls.all == [true])
    }

    @Test func aSignalAfterTheFirstCallRunsTheClosureAgain() async {
        let calls = Calls()
        let helper = TerminationSignals([SIGUSR1], queue: DispatchQueue(label: "termination-signals-test")) {
            calls.record(onQueue: true)
        }
        defer { helper.cancel() }
        kill(getpid(), SIGUSR1)
        #expect(await calls.wait(for: 1))
        kill(getpid(), SIGUSR1)
        #expect(await calls.wait(for: 2))
    }

    @Test func cancelGivesTheSignalItsDefaultActionBack() {
        let helper = TerminationSignals([SIGUSR1], queue: DispatchQueue(label: "termination-signals-test")) {}
        #expect(action(SIGUSR1) == 1)
        helper.cancel()
        #expect(action(SIGUSR1) == 0)
    }
}
