import Foundation
import Testing
@testable import TidegapKit

/// A login-shell query that fails at a busy login, or finds no `tidegap`,
/// is asked again, at most once per `loginShellRetryInterval`; an answer
/// with a `PATH` and a `tidegap` is kept.
@Suite struct LoginShellRetryTests {
    final class Clock {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        func advance(_ seconds: TimeInterval) { now += seconds }
    }

    /// Answers each query with the next entry; the last one repeats.
    final class LoginShell {
        var answers: [(path: String?, tidegap: String?)]
        private(set) var queries = 0

        init(_ answers: [(path: String?, tidegap: String?)]) { self.answers = answers }

        func query() -> (path: String?, tidegap: String?) {
            defer { queries += 1 }
            return answers[min(queries, answers.count - 1)]
        }
    }

    /// A query that hangs until the test answers it, like a startup file
    /// that waits on a permission prompt.
    final class HungLoginShell: @unchecked Sendable {
        private let lock = NSLock()
        private var waiter: CheckedContinuation<(path: String?, tidegap: String?), Never>?
        private var early: (path: String?, tidegap: String?)?
        private var count = 0
        var queries: Int { lock.withLock { count } }

        func query() async -> (path: String?, tidegap: String?) {
            await withCheckedContinuation { continuation in
                let answer: (path: String?, tidegap: String?)? = lock.withLock {
                    count += 1
                    if early == nil { waiter = continuation }
                    return early
                }
                if let answer { continuation.resume(returning: answer) }
            }
        }

        func answer(_ value: (path: String?, tidegap: String?)) {
            let waiting = lock.withLock {
                defer { waiter = nil }
                if waiter == nil { early = value }
                return waiter
            }
            waiting?.resume(returning: value)
        }
    }

    func makeLauncher(_ shell: LoginShell, _ clock: Clock) -> ServerLauncher {
        makeLauncher({ shell.query() }, clock)
    }

    func makeLauncher(
        _ query: @escaping () async -> (path: String?, tidegap: String?),
        _ clock: Clock,
        loginShellTimeout: TimeInterval = 10
    ) -> ServerLauncher {
        let launcher = ServerLauncher(
            runner: FakeRunner(),
            discovery: Discovery(tidegapHome: tempDir()),
            loginShell: query,
            isExecutable: { ["/login/bin/node", "/login/bin/tidegap"].contains($0) },
            baseEnvironment: ["PATH": "/usr/bin:/bin", "HOME": "/var/empty"],
            loginShellTimeout: loginShellTimeout,
            now: { clock.now }
        )
        launcher.commandOverride = ["node", "/repo/packages/cli/dist/index.js"]
        return launcher
    }

    @Test func aFailedLoginShellQueryIsAskedAgainAfter60s() async {
        let shell = LoginShell([(nil, nil), ("/login/bin:/usr/bin", nil)])
        let clock = Clock()
        let launcher = makeLauncher(shell, clock)
        #expect(await launcher.resolveCommand() == nil)
        clock.advance(10)
        #expect(await launcher.resolveCommand() == nil)
        #expect(shell.queries == 1)
        clock.advance(51)
        #expect(await launcher.resolveCommand() == ["/login/bin/node", "/repo/packages/cli/dist/index.js"])
        #expect(shell.queries == 2)
    }

    @Test func aFailedQueryIsNotRepeatedWithin60s() async {
        let shell = LoginShell([(nil, nil)])
        let clock = Clock()
        let launcher = makeLauncher(shell, clock)
        _ = await launcher.resolveCommand()
        clock.advance(59)
        _ = await launcher.resolveCommand()
        #expect(shell.queries == 1)
        clock.advance(1)
        _ = await launcher.resolveCommand()
        #expect(shell.queries == 2)
        // A second failure starts a new 60 s wait.
        clock.advance(59)
        _ = await launcher.resolveCommand()
        #expect(shell.queries == 2)
    }

    /// An interactive zsh ignores SIGTERM, so a hung startup file is not
    /// ended by the runner. The launcher stops waiting, and the next try
    /// waits on the same query rather than starting a second zsh.
    @Test func aHungQueryIsWaitedOnAgainNotStartedTwice() async {
        let shell = HungLoginShell()
        let clock = Clock()
        let launcher = makeLauncher({ await shell.query() }, clock, loginShellTimeout: 0.1)
        #expect(await launcher.resolveCommand() == nil)
        clock.advance(10)
        #expect(await launcher.resolveCommand() == nil)
        clock.advance(51)
        #expect(await launcher.resolveCommand() == nil)
        #expect(shell.queries == 1)
        shell.answer(("/login/bin:/usr/bin", nil))
        clock.advance(61)
        #expect(await launcher.resolveCommand() == ["/login/bin/node", "/repo/packages/cli/dist/index.js"])
        #expect(shell.queries == 1)
    }

    @Test func aSuccessfulQueryIsCached() async {
        let shell = LoginShell([("/login/bin:/usr/bin", "/login/bin/tidegap"), (nil, nil)])
        let clock = Clock()
        let launcher = makeLauncher(shell, clock)
        #expect(await launcher.resolveCommand() == ["/login/bin/node", "/repo/packages/cli/dist/index.js"])
        clock.advance(120)
        #expect(await launcher.resolveCommand() == ["/login/bin/node", "/repo/packages/cli/dist/index.js"])
        #expect(shell.queries == 1)
    }

    /// A `tidegap` installed later through a version manager is found by the
    /// next connect after the retry interval, without a restart.
    @Test func anAnswerWithoutTidegapIsAskedAgainAfter60s() async {
        let shell = LoginShell([("/login/bin:/usr/bin", nil), ("/login/bin:/usr/bin", "/login/bin/tidegap")])
        let clock = Clock()
        let launcher = makeLauncher(shell, clock)
        launcher.commandOverride = nil
        #expect(await launcher.resolveCommand() == nil)
        clock.advance(59)
        #expect(await launcher.resolveCommand() == nil)
        #expect(shell.queries == 1)
        clock.advance(2)
        #expect(await launcher.resolveCommand() == ["/login/bin/tidegap"])
        #expect(shell.queries == 2)
        clock.advance(120)
        #expect(await launcher.resolveCommand() == ["/login/bin/tidegap"])
        #expect(shell.queries == 2)
    }

    /// Until the retry finds `tidegap`, the last answer with a `PATH` still
    /// reaches the command and the child's environment.
    @Test func anAnswerWithoutTidegapKeepsServingItsPath() async {
        let shell = LoginShell([("/login/bin:/usr/bin", nil), (nil, nil)])
        let clock = Clock()
        let launcher = makeLauncher(shell, clock)
        #expect(await launcher.resolveCommand() == ["/login/bin/node", "/repo/packages/cli/dist/index.js"])
        #expect(await launcher.environment(for: ["/login/bin/node"])["PATH"]?.contains("/login/bin:/usr/bin") == true)
        clock.advance(61)
        #expect(await launcher.resolveCommand() == ["/login/bin/node", "/repo/packages/cli/dist/index.js"])
        #expect(shell.queries == 2)
        #expect(await launcher.environment(for: ["/login/bin/node"])["PATH"]?.contains("/login/bin:/usr/bin") == true)
        #expect(shell.queries == 2)
    }
}
