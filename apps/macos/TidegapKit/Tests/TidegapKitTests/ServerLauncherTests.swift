import Foundation
import Testing
@testable import TidegapKit

@Suite struct ServerLauncherTests {
    func launcher(
        runner: FakeRunner,
        home: URL = tempDir(),
        shell: (String?, String?) = ("/login/bin:/usr/bin", nil),
        executables: Set<String> = [],
        live: LivePids = LivePids(),
        versionTimeout: TimeInterval = 5,
        startTimeout: TimeInterval = 1
    ) -> ServerLauncher {
        ServerLauncher(
            runner: runner,
            discovery: Discovery(tidegapHome: home, isAlive: { live.contains($0) }),
            loginShell: { (path: shell.0, tidegap: shell.1) },
            isExecutable: { executables.contains($0) },
            baseEnvironment: ["PATH": "/usr/bin:/bin", "HOME": "/Users/test"],
            startTimeout: startTimeout,
            pollInterval: 0.01,
            killGrace: 0.05,
            versionTimeout: versionTimeout
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
        await #expect(throws: LaunchError.startTimedOut(seconds: 1)) { try await l.start() }
        let child = runner.children[0]
        #expect(child.terminated == 1)
        #expect(child.killed == 0)
        #expect(!child.isRunning)
    }

    @Test func timedOutStartKillsAChildThatIgnoresSigterm() async {
        let runner = FakeRunner(home: nil)
        runner.childExitsOnTerm = false
        let l = launcher(runner: runner, executables: ["/opt/homebrew/bin/tidegap"], live: runner.live, startTimeout: 0.2)
        await #expect(throws: LaunchError.startTimedOut(seconds: 0.2)) { try await l.start() }
        let child = runner.children[0]
        #expect(child.terminated == 1)
        #expect(child.killed == 1)
        #expect(!child.isRunning)
    }

    @Test func startAfterATimedOutOneSpawnsOnceTheOldChildIsGone() async {
        let runner = FakeRunner(home: nil)
        runner.childExitsOnTerm = false
        let l = launcher(runner: runner, executables: ["/opt/homebrew/bin/tidegap"], live: runner.live, startTimeout: 0.2)
        await #expect(throws: LaunchError.startTimedOut(seconds: 0.2)) { try await l.start() }
        var oldRunsAtSpawn: Bool?
        runner.onSpawn = { [runner] _ in oldRunsAtSpawn = runner.children[0].isRunning }
        await #expect(throws: LaunchError.startTimedOut(seconds: 0.2)) { try await l.start() }
        #expect(runner.spawns.count == 2)
        #expect(oldRunsAtSpawn == false)
    }

    /// A real `/bin/sh -c script` child and the real runner: its log holds
    /// what the child wrote. `ui --no-open` become $0 and $1 of the script.
    func shellLauncher(_ script: String) -> ServerLauncher {
        let l = ServerLauncher(
            runner: SystemProcessRunner(logURL: tempDir().appendingPathComponent("tidegap-ui.log")),
            discovery: Discovery(tidegapHome: tempDir()),
            loginShell: { (path: nil, tidegap: nil) },
            baseEnvironment: ["PATH": "/usr/bin:/bin", "HOME": tempDir().path],
            startTimeout: 10,
            pollInterval: 0.01
        )
        l.commandOverride = ["/bin/sh", "-c", script]
        return l
    }

    /// A real child that writes `output` to stderr and exits 1.
    func crashingLauncher(output: String) throws -> ServerLauncher {
        let file = tempDir().appendingPathComponent("output.txt")
        try output.write(to: file, atomically: true, encoding: .utf8)
        return shellLauncher("cat '\(file.path)' >&2; exit 1")
    }

    @Test func childThatExitsDuringStartReportsItsLastOutputLine() async {
        let l = shellLauncher("echo starting; echo 'Error: listen EADDRINUSE' >&2; echo; exit 1")
        let started = Date()
        await #expect(throws: LaunchError.exitedDuringStart(lastLine: "Error: listen EADDRINUSE")) { try await l.start() }
        #expect(Date().timeIntervalSince(started) < 5)
        #expect(l.child == nil)
        // Each spawn empties the log: a silent child gets no line from the run above.
        l.commandOverride = ["/bin/sh", "-c", "exit 1"]
        await #expect(throws: LaunchError.exitedDuringStart(lastLine: nil)) { try await l.start() }
    }

    @Test func nodeCrashDuringStartReportsTheErrorLine() async throws {
        // Node ends an uncaught exception with its version line.
        let l = try crashingLauncher(output: """
        node:internal/modules/cjs/loader:1228
          throw err;
          ^

        Error: Cannot find module '/repo/dist/index.js'
            at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)
            at node:internal/main/run_main_module:28:49 {
          code: 'MODULE_NOT_FOUND',
          requireStack: []
        }

        Node.js v22.0.0

        """)
        await #expect(throws: LaunchError.exitedDuringStart(lastLine: "Error: Cannot find module '/repo/dist/index.js'")) {
            try await l.start()
        }
    }

    @Test func longOutputLineIsCut() async throws {
        let l = try crashingLauncher(output: String(repeating: "x", count: 1000) + "\n")
        let cut = String(repeating: "x", count: SystemProcessRunner.maxOutputLine - 1) + "…"
        await #expect(throws: LaunchError.exitedDuringStart(lastLine: cut)) { try await l.start() }
    }

    @Test func causeLineSkipsNodeVersionLine() {
        #expect(causeLine("starting\nError: listen EADDRINUSE\n\n") == "Error: listen EADDRINUSE")
        let esm = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'\n    at f (file:///a.js:1:1) {\n  code: 'ERR_MODULE_NOT_FOUND'\n}\n\nNode.js v22.0.0\n"
        #expect(causeLine(esm) == "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'")
        // No error line above it: the version line stays.
        #expect(causeLine("boom\n\nNode.js v22.0.0\n") == "Node.js v22.0.0")
        #expect(causeLine("\n  \n") == nil)
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
        // Another app instance owns the server: reused whatever its version.
        #expect(verdict(record("0.18.0")) != .reuse)
        #expect(ServerVetting.verdict(record: record("0.18.0"), argv: ui, parent: 9002, parentIsOtherApp: true,
                                      currentVersion: "0.19.0", appStartedAt: start) == .reuse)
        #expect(ServerVetting.verdict(record: record("0.18.0"), argv: ["node", "/x/index.js", "tick"], parent: 9002,
                                      parentIsOtherApp: true, currentVersion: "0.19.0", appStartedAt: start) == .foreign)
        let exe = Self.appExecutable
        #expect(ServerVetting.isAppInstance([exe], appExecutable: exe))
        #expect(ServerVetting.isAppInstance(["/Users/dev/Build/Tidegap.app/Contents/MacOS/Tidegap", "-NSDocumentRevisionsDebugMode"], appExecutable: exe))
        #expect(!ServerVetting.isAppInstance(["/opt/homebrew/bin/node", "/opt/homebrew/bin/tidegap", "ui"], appExecutable: exe))
        #expect(!ServerVetting.isAppInstance(["/usr/local/bin/Tidegap"], appExecutable: exe))
        #expect(!ServerVetting.isAppInstance(nil, appExecutable: exe))
        #expect(!ServerVetting.isAppInstance([exe], appExecutable: nil))
    }

    static let appExecutable = "/Applications/Tidegap.app/Contents/MacOS/Tidegap"
    static let uiArgv = ["/opt/homebrew/bin/node", "/opt/homebrew/bin/tidegap", "ui", "--no-open"]

    /// A launcher as one app instance builds it, on a shared ui.json and process table.
    func appLauncher(
        runner: FakeRunner, home: URL, processes: FakeProcesses, clock: FakeClock,
        appPid: Int32, appExecutable: String = ServerLauncherTests.appExecutable
    ) -> ServerLauncher {
        let live = runner.live
        return ServerLauncher(
            runner: runner,
            discovery: Discovery(tidegapHome: home, isAlive: { live.contains($0) }),
            loginShell: { (path: "/usr/bin", tidegap: "/opt/homebrew/bin/tidegap") },
            isExecutable: { $0 == "/opt/homebrew/bin/tidegap" },
            baseEnvironment: ["PATH": "/usr/bin:/bin", "HOME": "/Users/test"],
            startTimeout: 1,
            pollInterval: 0.01,
            inspector: processes.inspector,
            startedAt: Wire.parseDate("2026-10-17T10:00:00Z")!,
            killGrace: 0.05,
            portIsFree: { _ in true },
            now: { clock.now },
            appExecutable: appExecutable,
            appPid: appPid
        )
    }

    /// What `ConnectionController.attach` does: a vetted ui.json server, else the own child.
    func poll(_ launcher: ServerLauncher) async throws -> Int32 {
        if let found = await launcher.adoptableServer() { return found.pid }
        return try await launcher.start().pid
    }

    /// Two app instances, A on runtime 1.0 and B on 1.1, polling every 15 s in
    /// turn for 30 minutes on one ui.json and process table. B runs
    /// `bExecutable`. The replaces (SIGTERMs to another instance's server), all
    /// SIGTERMs (those plus a stop of the own child), the spawns, and the last
    /// round's pids.
    func runTwoInstances(bFirst: Bool, bExecutable: String = "/Users/dev/Build/Tidegap.app/Contents/MacOS/Tidegap")
        async throws -> (replaces: Int, sigterms: Int, spawns: Int, pids: [Int32]) {
        let home = tempDir()
        let live = LivePids()
        let processes = FakeProcesses(live: live)
        let clock = FakeClock(Wire.parseDate("2026-10-17T10:00:00Z")!)
        processes.set(9001, argv: [Self.appExecutable], parent: 1)
        processes.set(9002, argv: [bExecutable], parent: 1)
        func runner(version: String, firstPid: Int32, appPid: Int32) -> FakeRunner {
            let r = FakeRunner(home: home, live: live)
            r.nextPid = firstPid
            r.spawnPort = 47999
            r.spawnVersion = version
            r.outputs["--version"] = CommandOutput(status: 0, stdout: version + "\n")
            r.onSpawn = { [processes, r] _ in processes.set(r.nextPid, argv: Self.uiArgv, parent: appPid) }
            return r
        }
        let runnerA = runner(version: "1.0", firstPid: 70001, appPid: 9001)
        let runnerB = runner(version: "1.1", firstPid: 80001, appPid: 9002)
        let a = appLauncher(runner: runnerA, home: home, processes: processes, clock: clock, appPid: 9001)
        let b = appLauncher(runner: runnerB, home: home, processes: processes, clock: clock, appPid: 9002,
                            appExecutable: bExecutable)
        let order = bFirst ? [b, a] : [a, b]
        var pids: [Int32] = []
        for _ in 0..<60 {
            pids = []
            for launcher in order {
                pids.append(try await poll(launcher))
                clock.advance(15)
            }
        }
        let replaces = processes.signals.filter { $0.sig == SIGTERM }.count
        let sigterms = replaces + (runnerA.children + runnerB.children).map(\.terminated).reduce(0, +)
        return (replaces, sigterms, runnerA.spawns.count + runnerB.spawns.count, pids)
    }

    /// R9: two app builds on different runtimes, polling for 30 minutes, settle on
    /// one server and send at most one SIGTERM in all, whichever starts first.
    @Test(arguments: [false, true])
    func twoAppInstancesSettleOnOneServer(bFirst: Bool) async throws {
        let run = try await runTwoInstances(bFirst: bFirst)
        #expect(run.sigterms <= 1)
        #expect(run.pids[0] == run.pids[1])
        #expect(run.spawns == 1)
    }

    /// The backstop alone: instances whose executables do not match each other
    /// replace at most once per `replaceHoldInterval` each, so 30 minutes hold
    /// at most six replaces, not one per poll.
    @Test func instancesTheParentRuleMissesReplaceOncePerTenMinutes() async throws {
        let run = try await runTwoInstances(bFirst: false, bExecutable: "/Applications/Tidegap Dev.app/Contents/MacOS/Tidegap Dev")
        #expect(run.replaces >= 1)
        #expect(run.replaces <= 6)
    }

    /// A launcher on version 0.19.0 and a ui.json server `pid` on `version` under `parent`.
    func vettingWorld(pid: Int32 = 4242, version: String = "0.18.0", parent: Int32 = 501)
        -> (launcher: ServerLauncher, processes: FakeProcesses, clock: FakeClock, home: URL, live: LivePids) {
        let home = tempDir()
        let runner = FakeRunner(home: home)
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.19.0\n")
        let processes = FakeProcesses(live: runner.live)
        let clock = FakeClock(Wire.parseDate("2026-10-17T10:00:00Z")!)
        processes.set(9001, argv: [Self.appExecutable], parent: 1)
        processes.set(9002, argv: ["/Users/dev/Build/Tidegap.app/Contents/MacOS/Tidegap"], parent: 1)
        processes.set(pid, argv: Self.uiArgv, parent: parent)
        runner.live.add(pid)
        writeDiscovery(home: home, pid: pid, port: 47999, cliVersion: version)
        let l = appLauncher(runner: runner, home: home, processes: processes, clock: clock, appPid: 9001)
        return (l, processes, clock, home, runner.live)
    }

    @Test func aServerOfAnotherAppInstanceIsReusedOnAVersionMismatch() async {
        let w = vettingWorld(parent: 9002)
        #expect(await w.launcher.adoptableServer()?.pid == 4242)
        #expect(w.processes.signals.isEmpty)
    }

    /// The parent rule needs a live app: a gone parent, or this app itself, falls
    /// back to the version rule.
    @Test func aServerWhoseParentIsNotAnotherLiveAppIsReplaced() async {
        let gone = vettingWorld(parent: 9003)
        gone.processes.set(9003, argv: nil, parent: 1)
        #expect(await gone.launcher.adoptableServer() == nil)
        #expect(gone.processes.sent == [SIGTERM])
        let mine = vettingWorld(parent: 9001)
        #expect(await mine.launcher.adoptableServer() == nil)
        #expect(mine.processes.sent == [SIGTERM])
    }

    /// One replace per `replaceHoldInterval`: a second old server inside it is
    /// reused, one after it is replaced again.
    @Test func aSecondReplaceWithinTenMinutesIsHeld() async {
        let w = vettingWorld()
        #expect(await w.launcher.adoptableServer() == nil)
        #expect(w.processes.signals.map(\.pid) == [4242])
        w.clock.advance(300)
        w.processes.set(4343, argv: Self.uiArgv)
        w.live.add(4343)
        writeDiscovery(home: w.home, pid: 4343, port: 47999, cliVersion: "0.18.0")
        #expect(await w.launcher.adoptableServer()?.pid == 4343)
        w.clock.advance(299)
        #expect(await w.launcher.adoptableServer()?.pid == 4343)
        #expect(w.processes.signals.map(\.pid) == [4242])
        w.clock.advance(1)
        #expect(await w.launcher.adoptableServer() == nil)
        #expect(w.processes.signals.map(\.pid) == [4242, 4343])
    }

    /// A clock set back after a replace ends the hold instead of stretching it.
    @Test func aClockSetBackEndsTheHold() async {
        let w = vettingWorld()
        #expect(await w.launcher.adoptableServer() == nil)
        w.clock.advance(-3600)
        w.processes.set(4343, argv: Self.uiArgv)
        w.live.add(4343)
        writeDiscovery(home: w.home, pid: 4343, port: 47999, cliVersion: "0.18.0")
        #expect(await w.launcher.adoptableServer() == nil)
        #expect(w.processes.signals.map(\.pid) == [4242, 4343])
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

    @Test func stuckVersionRunIsNotStartedAgain() async throws {
        let runner = FakeRunner()
        let l = launcher(runner: runner, shell: ("/usr/bin", "/opt/homebrew/bin/tidegap"),
                         executables: ["/opt/homebrew/bin/tidegap"], versionTimeout: 0.05)
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.19.0\n")
        runner.delays["--version"] = 0.3
        var versionRuns: Int { runner.runs.filter { $0.contains("--version") }.count }
        #expect(await l.currentVersion() == nil)
        #expect(await l.currentVersion() == nil)
        #expect(versionRuns == 1)
        // The late answer goes to the next call, and then a new run starts.
        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(await l.currentVersion() == "0.19.0")
        #expect(versionRuns == 1)
        runner.delays["--version"] = nil
        #expect(await l.currentVersion() == "0.19.0")
        #expect(versionRuns == 2)
    }

    @Test func timeoutDoesNotWaitForAnOperationThatIgnoresCancellation() async {
        let started = Date()
        let value: Int? = await withTimeout(0.05) {
            await withCheckedContinuation { continuation in
                DispatchQueue.global().asyncAfter(deadline: .now() + 1) { continuation.resume(returning: 1) }
            }
        }
        #expect(value == nil)
        #expect(Date().timeIntervalSince(started) < 0.5)
        #expect(await withTimeout(1) { 7 } == 7)
    }

    @Test func loopbackPortProbeSeesAListener() throws {
        // A port below the ephemeral range. The kernel never gives such a port to an
        // outgoing connection, so no test that runs in parallel (APIClientTests makes a
        // real loopback request) and no other process can take it between close and the
        // probe. A kernel-picked port is ephemeral and could be taken in that gap.
        var first: Int32 = 0
        var size = MemoryLayout<Int32>.size
        try #require(sysctlbyname("net.inet.ip.portrange.first", &first, &size, nil, 0) == 0)
        try #require(Int(first) - 1 >= 1024)
        let band = max(1024, Int(first) - 1000)...(Int(first) - 1)
        var picked: (fd: Int32, port: Int)?
        for port in band where port != 47821 {
            if let fd = loopbackListener(port: port) {
                picked = (fd, port)
                break
            }
        }
        let (fd, port) = try #require(picked)
        var open = true
        defer { if open { close(fd) } }
        #expect(band.contains(port) && port != 47821)
        #expect(!ServerLauncher.loopbackPortIsFree(port))
        close(fd)
        open = false
        #expect(ServerLauncher.loopbackPortIsFree(port))
    }

    /// A listener on 127.0.0.1:`port` with SO_REUSEADDR, as Node sets it; nil when the port is taken.
    private func loopbackListener(port: Int) -> Int32? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let listening = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 && listen(fd, 1) == 0
            }
        }
        if listening { return fd }
        close(fd)
        return nil
    }
}
