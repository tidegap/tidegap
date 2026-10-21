import Foundation
import Testing
@testable import TidegapKit

@Suite struct ServerLauncherTests {
    func launcher(
        runner: FakeRunner,
        home: URL = tempDir(),
        shell: (String?, String?) = ("/login/bin:/usr/bin", nil),
        executables: Set<String> = [],
        live: LivePids = LivePids()
    ) -> ServerLauncher {
        ServerLauncher(
            runner: runner,
            discovery: Discovery(tidegapHome: home, isAlive: { live.contains($0) }),
            loginShell: { (path: shell.0, tidegap: shell.1) },
            isExecutable: { executables.contains($0) },
            baseEnvironment: ["PATH": "/usr/bin:/bin", "HOME": "/Users/test"],
            startTimeout: 1,
            pollInterval: 0.01
        )
    }

    @Test func overrideWins() async {
        let l = launcher(runner: FakeRunner(), shell: ("/login/bin", "/login/bin/tidegap"),
                         executables: ["/login/bin/node", "/login/bin/tidegap"])
        l.commandOverride = ["node", "/repo/packages/cli/dist/index.js"]
        #expect(await l.resolveCommand() == ["/login/bin/node", "/repo/packages/cli/dist/index.js"])
    }

    @Test func loginShellLookupIsNext() async {
        let l = launcher(runner: FakeRunner(), shell: ("/login/bin", "/login/bin/tidegap"),
                         executables: ["/login/bin/tidegap", "/opt/homebrew/bin/tidegap"])
        #expect(await l.resolveCommand() == ["/login/bin/tidegap"])
    }

    @Test func knownPathsAreLast() async {
        let l = launcher(runner: FakeRunner(), shell: (nil, nil), executables: ["/Users/test/.volta/bin/tidegap"])
        #expect(await l.resolveCommand() == ["/Users/test/.volta/bin/tidegap"])
    }

    @Test func nothingFoundIsNotFound() async {
        let l = launcher(runner: FakeRunner(), shell: (nil, nil))
        #expect(await l.resolveCommand() == nil)
        await #expect(throws: LaunchError.tidegapNotFound) { try await l.run(["--version"]) }
    }

    @Test func childGetsLoginPathAndArgvWithoutShell() async throws {
        let home = tempDir()
        let runner = FakeRunner(home: home)
        let l = launcher(runner: runner, home: home, executables: ["/opt/homebrew/bin/tidegap"], live: runner.live)
        l.port = 47931
        let server = try await l.start()
        #expect(server.port == 47931)
        #expect(runner.spawns == [["/opt/homebrew/bin/tidegap", "ui", "--no-open", "--port", "47931"]])
        let path = runner.environments.last?["PATH"] ?? ""
        #expect(path.hasPrefix("/opt/homebrew/bin:/login/bin:/usr/bin"))
        #expect(!runner.spawns[0].contains { $0.contains("-c") })
    }

    @Test func terminatesOnlyItsOwnChild() async throws {
        // AE5: an external server named by ui.json is never touched.
        let home = tempDir()
        let runner = FakeRunner(home: home)
        let external = FakeProcess(pid: 4242)
        runner.live.add(external.pid)
        writeDiscovery(home: home, pid: external.pid, port: 47821)
        let l = launcher(runner: runner, home: home, executables: ["/opt/homebrew/bin/tidegap"], live: runner.live)
        l.stop()
        #expect(external.terminated == 0)
        _ = try await l.start()
        l.stop()
        #expect(runner.children.count == 1)
        #expect(runner.children[0].terminated == 1)
        #expect(external.terminated == 0)
    }

    @Test func changedPortRespawnsTheChild() async throws {
        let home = tempDir()
        let runner = FakeRunner(home: home)
        let l = launcher(runner: runner, home: home, executables: ["/opt/homebrew/bin/tidegap"], live: runner.live)
        l.port = 47931
        _ = try await l.start()
        _ = try await l.start()
        #expect(runner.spawns.count == 1)
        l.port = 47932
        runner.spawnPort = 47932
        let server = try await l.start()
        #expect(runner.spawns.count == 2)
        #expect(runner.children[0].terminated == 1)
        #expect(server.port == 47932)
    }

    @Test func loginShellOutputIsReadFromMarkers() {
        let out = "Welcome to zsh\n__TG_PATH__/Users/me/.nvm/versions/node/v22/bin:/usr/bin\n__TG_BIN__/Users/me/.nvm/versions/node/v22/bin/tidegap\n"
        let info = ServerLauncher.parseLoginShell(out)
        #expect(info.path == "/Users/me/.nvm/versions/node/v22/bin:/usr/bin")
        #expect(info.tidegap == "/Users/me/.nvm/versions/node/v22/bin/tidegap")
        let missing = ServerLauncher.parseLoginShell("__TG_PATH__/usr/bin\n__TG_BIN__\n")
        #expect(missing.tidegap == nil)
    }

    @Test func startTimesOutWhenNoDiscoveryAppears() async {
        let runner = FakeRunner(home: nil)
        let l = launcher(runner: runner, executables: ["/opt/homebrew/bin/tidegap"], live: runner.live)
        await #expect(throws: LaunchError.startTimedOut) { try await l.start() }
        #expect(runner.children.first?.terminated == 1)
    }

    @Test func splitsSettingsCommandLine() {
        #expect(CommandLineSplitter.split(#"node "/my repo/dist/index.js""#) == ["node", "/my repo/dist/index.js"])
        #expect(CommandLineSplitter.split("  a  'b c'  d\\ e ") == ["a", "b c", "d e"])
        #expect(CommandLineSplitter.split("") == [])
    }

    @Test func ownChildOnOldVersionIsRespawned() async throws {
        let home = tempDir()
        let runner = FakeRunner(home: home)
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.19.0\n")
        let l = launcher(runner: runner, home: home, executables: ["/opt/homebrew/bin/tidegap"], live: runner.live)
        _ = try await l.start()
        _ = try await l.start()
        #expect(runner.spawns.count == 1)
        // A runtime update: the child still runs 0.19.0, the command now says 0.20.0.
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.20.0\n")
        _ = try await l.start()
        #expect(runner.spawns.count == 2)
        #expect(runner.children[0].terminated == 1)
    }

    @Test func verdictTable() {
        let start = Wire.parseDate("2026-10-17T10:00:00Z")!
        func record(_ version: String?, _ startedAt: String = "2026-10-17T09:00:00.000Z") -> DiscoveryRecord {
            DiscoveryRecord(version: 1, pid: 4242, port: 47999, url: nil, startedAt: startedAt, cliVersion: version)
        }
        let ui = ["node", "/repo/dist/index.js", "ui", "--no-open"]
        func verdict(_ r: DiscoveryRecord, argv: [String]? = ui, parent: Int32? = 501, current: String? = "0.19.0") -> ServerVerdict {
            ServerVetting.verdict(record: r, argv: argv, parent: parent, currentVersion: current, appStartedAt: start)
        }
        #expect(verdict(record("0.19.0")) == .reuse)
        #expect(verdict(record("0.19.0"), argv: ["node", "/x/index.js", "tick"]) == .foreign)
        #expect(verdict(record("0.19.0"), argv: nil) == .foreign)
        #expect(verdict(record("0.18.0")) == .replace("version 0.18.0, expected 0.19.0"))
        #expect(verdict(record(nil)) == .replace("version unknown, expected 0.19.0"))
        #expect(verdict(record("0.18.0"), current: nil) == .reuse)
        #expect(verdict(record("0.19.0"), parent: 1) == .replace("orphan of an earlier run"))
        #expect(verdict(record("0.19.0", "2026-10-17T10:00:01.000Z"), parent: 1) == .reuse)
        let undated = DiscoveryRecord(version: 1, pid: 4242, port: 47999, url: nil, startedAt: nil, cliVersion: "0.19.0")
        #expect(verdict(undated, parent: 1) == .replace("orphan of an earlier run"))
        #expect(ServerVetting.isTidegapUI(["node", "/opt/homebrew/bin/tidegap", "ui"]))
        #expect(!ServerVetting.isTidegapUI(["node", "/x/index.js"]))
    }

    @Test func systemInspectorReadsThisProcess() throws {
        let me = getpid()
        #expect(ProcessInspector.systemArguments(me) == CommandLine.arguments)
        #expect(ProcessInspector.system.parent(me) == getppid())
        let started = try #require(ProcessInspector.system.startTime(me))
        #expect(started <= Date().timeIntervalSince1970)
        #expect(started > Date().timeIntervalSince1970 - 86_400)
    }

    @Test func versionIsTheLastNonEmptyStdoutLine() async {
        let runner = FakeRunner()
        let l = launcher(runner: runner, shell: ("/usr/bin", "/opt/homebrew/bin/tidegap"), executables: ["/opt/homebrew/bin/tidegap"])
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "npm warn config something\n0.19.0  \n\n")
        #expect(await l.currentVersion() == "0.19.0")
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "\n")
        #expect(await l.currentVersion() == nil)
        runner.outputs["--version"] = CommandOutput(status: 1, stdout: "0.19.0\n")
        #expect(await l.currentVersion() == nil)
    }
}
