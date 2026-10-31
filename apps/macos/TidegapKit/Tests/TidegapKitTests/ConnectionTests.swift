import Foundation
import Testing
@testable import TidegapKit

@MainActor
@Suite struct ConnectionTests {
    let home = tempDir()
    let support = tempDir()
    let runner: FakeRunner
    let server = FakeServer()
    let processes: FakeProcesses
    /// The app started at 10:00; the default ui.json says 09:00.
    let appStart = date("2026-10-17T10:00:00Z")

    init() {
        runner = FakeRunner(home: home)
        processes = FakeProcesses(live: runner.live)
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.19.0\n")
        runner.outputs["clients add --name Tidegap for Mac --kind macos --json"] =
            CommandOutput(status: 0, stdout: #"{"client_id":"c1","token":"tgc_minted"}"# + "\n")
    }

    let clock = FakeClock(date("2026-10-17T10:00:00Z"))
    let ports = FakePorts()

    func controller(
        executables: Set<String> = ["/opt/homebrew/bin/tidegap"],
        isExecutable: ((String) -> Bool)? = nil,
        port: Int? = nil,
        versionTimeout: TimeInterval = 5
    ) -> ConnectionController {
        let live = runner.live
        let discovery = Discovery(tidegapHome: home, isAlive: { live.contains($0) })
        let launcher = ServerLauncher(
            runner: runner, discovery: discovery,
            loginShell: { (path: "/usr/bin", tidegap: "/opt/homebrew/bin/tidegap") },
            isExecutable: isExecutable ?? { executables.contains($0) },
            startTimeout: 1, pollInterval: 0.01,
            inspector: processes.inspector, startedAt: appStart, killGrace: 0.05,
            versionTimeout: versionTimeout, portIsFree: ports.isFree
        )
        launcher.port = port
        let transport = server.transport
        return ConnectionController(
            store: TokenStore(directory: support), launcher: launcher,
            makeClient: { APIClient(port: $0, token: $1, transport: transport) },
            now: { [clock] in clock.now }
        )
    }

    @Test func attachesToLiveServerWithoutSpawning() async {
        // AE5, first half.
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47999, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47999, ownsServer: false))
        #expect(runner.spawns.isEmpty)
        #expect(runner.mintCalls == 1)
        #expect(TokenStore(directory: support).read() == "tgc_minted")
    }

    @Test func spawnsWhenNoDiscoveryAndStopsOnlyThatChild() async {
        // AE5, second half.
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47931, ownsServer: true))
        #expect(runner.spawns.count == 1)
        c.shutdown()
        #expect(runner.children[0].terminated == 1)
    }

    @Test func unauthorizedDropsTokenWithoutMinting() async throws {
        try TokenStore(directory: support).write("tgc_old")
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47999, status: 401)
        let c = controller()
        await c.connect()
        #expect(c.state == .revoked)
        #expect(runner.mintCalls == 0)
        #expect(TokenStore(directory: support).read() == nil)

        // The revoke sticks across a relaunch: a new controller mints nothing.
        let relaunched = controller()
        await relaunched.connect()
        #expect(relaunched.state == .revoked)
        #expect(runner.mintCalls == 0)

        server.set(port: 47999, status: 200)
        await relaunched.reconnect()
        #expect(relaunched.state == .connected(port: 47999, ownsServer: false))
        #expect(runner.mintCalls == 1)
    }

    @Test func revokeWhileConnectedShowsReconnectWithoutMinting() async {
        // The server ends the event stream on revoke; the app's refetch gets 401.
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47999, status: 200)
        let c = controller()
        await c.connect()
        #expect(runner.mintCalls == 1)
        server.set(port: 47999, status: 401)
        await c.refresh()
        #expect(c.state == .revoked)
        #expect(c.summary == nil)
        #expect(TokenStore(directory: support).read() == nil)
        await c.refresh()
        await c.connect()
        #expect(c.state == .revoked)
        #expect(runner.mintCalls == 1)
    }

    @Test func oldCLIGivesUpdateStateAndNoMint() async {
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.18.0\n")
        let c = controller()
        await c.connect()
        #expect(c.state == .needsUpdate(version: "0.18.0"))
        #expect(runner.mintCalls == 0)
        #expect(c.state.lacksToken)
    }

    // MARK: The poll with no token (KTD11)

    @Test func pollConnectsAfterTidegapNotFoundOnceTidegapIsInstalled() async {
        final class Installed { var paths: Set<String> = [] }
        let installed = Installed()
        server.set(port: 47931, status: 200)
        let c = controller(isExecutable: { installed.paths.contains($0) })
        await c.connect()
        #expect(c.state == .tidegapNotFound)
        #expect(runner.mintCalls == 0)
        // The user installs tidegap in a terminal; the next poll finds it.
        installed.paths = ["/opt/homebrew/bin/tidegap"]
        await c.refresh()
        #expect(runner.mintCalls == 1)
        #expect(c.state == .connected(port: 47931, ownsServer: true))
        #expect(TokenStore(directory: support).read() == "tgc_minted")
    }

    @Test func pollRunsTheConnectSequenceAgainAfterNeedsUpdate() async {
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.18.0\n")
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .needsUpdate(version: "0.18.0"))
        // The user updates tidegap in a terminal; the next poll mints.
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.19.0\n")
        await c.refresh()
        #expect(runner.mintCalls == 1)
        #expect(c.state == .connected(port: 47931, ownsServer: true))
    }

    @Test func pollWaitsForReconnectAfterARevoke() async throws {
        try TokenStore(directory: support).write("tgc_old")
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47999, status: 401)
        let c = controller()
        await c.connect()
        #expect(c.state == .revoked)
        var changes = 0
        c.onChange = { changes += 1 }
        server.set(port: 47999, status: 200)
        await c.refresh()
        #expect(changes == 0)
        #expect(c.state == .revoked)
        #expect(runner.mintCalls == 0)
        #expect(!ConnectionState.revoked.pollMayConnect)
        #expect(ConnectionState.tidegapNotFound.pollMayConnect)
        #expect(ConnectionState.needsUpdate(version: "0.18.0").pollMayConnect)
        // The badge still reads "?" in all three.
        #expect(ConnectionState.tidegapNotFound.lacksToken && ConnectionState.needsUpdate(version: "0.18.0").lacksToken)
    }

    @Test func repoBuildWithOldVersionButClientsCommandMints() async {
        // Before the 0.19 release the repo build still reports 0.18.0.
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.18.0\n")
        runner.outputs["clients list --json"] = CommandOutput(status: 0, stdout: #"{"clients":[]}"#)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(runner.mintCalls == 1)
        #expect(c.state == .connected(port: 47931, ownsServer: true))
    }

    @Test func externalServerStopsThenOwnChildAfterTwoFailedPolls() async {
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47999, status: 200)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47999, ownsServer: false))

        // The external server quits: its pid dies and its ui.json goes away.
        server.set(port: 47999, status: nil)
        runner.live.remove(4242)
        try? FileManager.default.removeItem(at: home.appendingPathComponent("ui.json"))

        await c.refresh()
        #expect(runner.spawns.isEmpty)
        #expect(c.state == .offline("tidegap ui is not reachable"))
        await c.refresh()
        #expect(runner.spawns.count == 1)
        #expect(c.state == .connected(port: 47931, ownsServer: true))
        await c.refresh()
        #expect(runner.spawns.count == 1)
    }

    @Test func liveDiscoveryThatRefusesFallsBackToSpawn() async throws {
        try TokenStore(directory: support).write("tgc_old")
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47931, ownsServer: true))
        #expect(runner.spawns.count == 1)
    }

    // MARK: Reusing a ui.json server (decision table)

    @Test func stalePidSpawnsWithoutSignals() async {
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47931, ownsServer: true))
        #expect(processes.signals.isEmpty)
    }

    @Test func versionMismatchIsTerminatedAndReplaced() async {
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47999, status: 200)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(processes.sent == [SIGTERM])
        #expect(c.state == .connected(port: 47931, ownsServer: true))
        #expect(runner.spawns.count == 1)
    }

    @Test func serverIgnoringSigtermGetsSigkill() async {
        processes.exitsOnTerm = false
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(processes.sent == [SIGTERM, SIGKILL])
        #expect(!runner.live.contains(4242))
        #expect(c.state == .connected(port: 47931, ownsServer: true))
    }

    @Test func oursAndCurrentIsReused() async {
        runner.live.add(4242)
        processes.set(4242, argv: ["/usr/local/bin/node", "/repo/packages/cli/dist/index.js", "ui"], parent: 501)
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47999, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47999, ownsServer: false))
        #expect(runner.spawns.isEmpty)
        #expect(processes.signals.isEmpty)
    }

    @Test func orphanOfAnEarlierRunIsReplaced() async {
        runner.live.add(4242)
        processes.set(4242, argv: ["node", "/Users/me/.tidegap/runtime/dist/index.js", "ui", "--no-open"], parent: 1)
        writeDiscovery(home: home, pid: 4242, port: 47999, startedAt: "2026-10-16T09:00:00.000Z")
        server.set(port: 47999, status: 200)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(processes.sent == [SIGTERM])
        #expect(c.state == .connected(port: 47931, ownsServer: true))
    }

    @Test func orphanStartedAfterTheAppIsReused() async {
        runner.live.add(4242)
        processes.set(4242, argv: ["node", "/x/index.js", "ui"], parent: 1)
        writeDiscovery(home: home, pid: 4242, port: 47999, startedAt: "2026-10-17T10:05:00.000Z")
        server.set(port: 47999, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47999, ownsServer: false))
        #expect(processes.signals.isEmpty)
    }

    @Test func foreignProcessOnThePidIsLeftAlone() async throws {
        // A stored token: no mint, so any `--version` run would be the vetting's.
        try TokenStore(directory: support).write("tgc_old")
        runner.live.add(4242)
        processes.set(4242, argv: ["/Applications/Safari.app/Contents/MacOS/Safari"], parent: 1)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47999, status: 200)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(processes.signals.isEmpty)
        #expect(runner.live.contains(4242))
        #expect(!runner.runs.contains { $0.contains("--version") })
        #expect(c.state == .connected(port: 47931, ownsServer: true))
    }

    @Test func unreadableArgvCountsAsForeign() async {
        runner.live.add(4242)
        processes.set(4242, argv: nil)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(processes.signals.isEmpty)
        #expect(c.state == .connected(port: 47931, ownsServer: true))
    }

    @Test func reattachAfterFailedPollsVetsTheServerAgain() async {
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47931, ownsServer: true))

        // The app's child dies; meanwhile an old server took over ui.json.
        runner.children[0].isRunning = false
        runner.live.remove(runner.children[0].pid)
        server.set(port: 47931, status: nil)
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47999, status: 200)
        runner.spawnPort = 47932
        server.set(port: 47932, status: 200)

        await c.refresh()
        await c.refresh()
        #expect(processes.sent == [SIGTERM])
        #expect(c.state == .connected(port: 47932, ownsServer: true))
        #expect(runner.spawns.count == 2)
    }
    // MARK: Signalling only the vetted process

    @Test func pidReusedBeforeSigtermIsLeftAlone() async throws {
        try TokenStore(directory: support).write("tgc_old")
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47931, status: 200)
        // `tidegap --version` runs between the vetting and the signal; the
        // server exits meanwhile and another `tidegap ui` gets its pid.
        runner.onRun = { [processes] argv in
            if argv.contains("--version") { processes.setStart(4242, 2000) }
        }
        let c = controller()
        await c.connect()
        #expect(processes.signals.isEmpty)
        #expect(runner.live.contains(4242))
        #expect(c.state == .connected(port: 47931, ownsServer: true))
    }

    @Test func pidReusedBeforeSigkillIsLeftAlone() async {
        processes.exitsOnTerm = false
        processes.afterSignal = { [processes] pid, sig in
            if sig == SIGTERM { processes.set(pid, argv: ["/usr/bin/vim"]) }
        }
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(processes.sent == [SIGTERM])
        #expect(runner.live.contains(4242))
    }

    @Test func launchdAndTheAppItselfAreNeverSignalled() async {
        for pid in [1, getpid()] {
            runner.live.add(pid)
            writeDiscovery(home: home, pid: pid, port: 47999, cliVersion: "0.18.0")
            server.set(port: 47931, status: 200)
            let c = controller()
            await c.connect()
            #expect(processes.signals.isEmpty)
        }
        #expect(!ServerVetting.isSignallable(0))
        #expect(!ServerVetting.isSignallable(-4242))
        #expect(ServerVetting.isSignallable(4242))
    }

    @Test func oldServerIsKeptWhenNoCommandCanReplaceIt() async throws {
        try TokenStore(directory: support).write("tgc_old")
        runner.live.add(4242)
        processes.set(4242, argv: ["node", "/x/index.js", "ui"], parent: 1)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47999, status: 200)
        let c = controller(executables: [])
        await c.connect()
        #expect(processes.signals.isEmpty)
        #expect(c.state == .connected(port: 47999, ownsServer: false))
    }

    // MARK: A failed start names its cause

    @Test func spawnErrorIsShown() async {
        runner.spawnError = NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES),
                                    userInfo: [NSLocalizedDescriptionKey: "permission denied"])
        let c = controller()
        await c.connect()
        #expect(c.state == .offline("Could not run tidegap ui: permission denied"))
    }

    @Test func childWithoutUIJSONNamesTheTimeLimit() async {
        runner.childStart = .hangs
        let c = controller()
        await c.connect()
        #expect(c.state == .offline("tidegap ui did not start within 1 s."))
    }

    @Test func childThatExitsDuringStartQuotesItsLastLine() async {
        runner.childStart = .exits(lastLine: "Error: listen EADDRINUSE")
        let c = controller()
        await c.connect()
        #expect(c.state == .offline("tidegap ui exited during start: Error: listen EADDRINUSE"))
    }

    @Test func childThatExitsWithoutOutputSaysSo() async {
        runner.childStart = .exits(lastLine: nil)
        let c = controller()
        await c.connect()
        #expect(c.state == .offline("tidegap ui exited during start without output."))
    }

    @Test func missingCommandAtAttachIsNotFound() async throws {
        try TokenStore(directory: support).write("tgc_old")
        let c = controller(executables: [])
        await c.connect()
        #expect(c.state == .tidegapNotFound)
        #expect(runner.spawns.isEmpty)
    }

    // MARK: Restarting on the default port

    /// The old server holds 47821 until it exits, and the kernel reports
    /// the port taken for `linger` more probes after that.
    func oldServerOnDefaultPort(linger: Int = 2) {
        let port = ServerLauncher.defaultUIPort
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: port, cliVersion: "0.18.0")
        ports.hold(port)
        processes.afterSignal = { [runner, ports] pid, _ in
            if !runner.live.contains(pid) {
                ports.release(port)
                ports.lingerProbes = linger
            }
        }
        runner.spawnPort = port
        server.set(port: port, status: 200)
    }

    @Test func replacedServerExitsAndFreesTheDefaultPortBeforeTheSpawn() async {
        oldServerOnDefaultPort()
        var atSpawn: (oldAlive: Bool, linger: Int)?
        runner.onSpawn = { [runner, ports] _ in atSpawn = (runner.live.contains(4242), ports.lingerProbes) }
        let c = controller()
        await c.connect()
        #expect(processes.sent == [SIGTERM])
        #expect(atSpawn?.oldAlive == false)
        #expect(atSpawn?.linger == 0)
        #expect(c.state == .connected(port: ServerLauncher.defaultUIPort, ownsServer: true))
    }

    @Test func serverIgnoringSigtermIsKilledBeforeTheSpawn() async {
        processes.exitsOnTerm = false
        oldServerOnDefaultPort()
        var signalsAtSpawn: [Int32] = []
        runner.onSpawn = { [processes] _ in signalsAtSpawn = processes.sent }
        let c = controller()
        await c.connect()
        #expect(signalsAtSpawn == [SIGTERM, SIGKILL])
        #expect(ports.lingerProbes == 0)
    }

    @Test func portIsNotAwaitedWithAnExplicitPortOrAnotherPort() async {
        oldServerOnDefaultPort()
        let c = controller(port: ServerLauncher.defaultUIPort)
        await c.connect()
        #expect(processes.sent == [SIGTERM])
        #expect(ports.probes == 0)

        // The old server on a random port: 47821 was never its.
        runner.live.add(4243)
        writeDiscovery(home: home, pid: 4243, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47931, status: 200)
        runner.spawnPort = 47931
        let d = controller()
        await d.connect()
        #expect(ports.probes == 0)
    }

    // MARK: Runtime update mid-session

    var versionRuns: Int { runner.runs.filter { $0.contains("--version") }.count }

    @Test func runtimeUpdateRestartsOwnChildOnceOnTheSamePort() async {
        let port = ServerLauncher.defaultUIPort
        runner.spawnPort = port
        server.set(port: port, status: 200)
        let c = controller()
        await c.connect()
        let old = runner.children[0]
        let afterConnect = versionRuns

        // Polls within five minutes run no `--version`.
        clock.advance(60)
        await c.refresh()
        #expect(versionRuns == afterConnect)

        // The runtime is updated; the old child ignores SIGTERM and holds the port.
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.20.0\n")
        runner.spawnVersion = "0.20.0"
        old.exitsOnTerm = false
        ports.hold(port)
        old.onExit = { [runner, ports] in
            runner.live.remove(old.pid)
            ports.release(port)
            ports.lingerProbes = 2
        }
        var atSpawn: (oldRunning: Bool, linger: Int)?
        runner.onSpawn = { [ports] _ in atSpawn = (old.isRunning, ports.lingerProbes) }

        clock.advance(3 * 60)
        await c.refresh()
        #expect(runner.spawns.count == 1)
        clock.advance(2 * 60)
        await c.refresh()
        #expect(runner.spawns.count == 2)
        #expect(old.terminated == 1)
        #expect(old.killed == 1)
        #expect(atSpawn?.oldRunning == false)
        #expect(atSpawn?.linger == 0)
        #expect(c.state == .connected(port: port, ownsServer: true))

        for _ in 0..<6 {
            clock.advance(301)
            await c.refresh()
        }
        #expect(runner.spawns.count == 2)
    }

    @Test func runtimeUpdateReplacesAnAdoptedServer() async {
        runner.live.add(4242)
        writeDiscovery(home: home, pid: 4242, port: 47999)
        server.set(port: 47999, status: 200)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(c.state == .connected(port: 47999, ownsServer: false))

        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.20.0\n")
        runner.spawnVersion = "0.20.0"
        clock.advance(301)
        await c.refresh()
        #expect(processes.sent == [SIGTERM])
        #expect(runner.spawns.count == 1)
        #expect(c.state == .connected(port: 47931, ownsServer: true))
    }

    @Test func restartIsNotRepeatedForTheSameVersion() async {
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        // `--version` says 0.20.0, but every new child still reports 0.19.0.
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.20.0\n")
        for _ in 0..<24 {
            clock.advance(301)
            await c.refresh()
        }
        #expect(runner.spawns.count == 2)
        #expect(runner.children[0].terminated == 1)
    }

    @Test func secondUpdateWaitsForTheCooldown() async {
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        func update(to version: String) {
            runner.outputs["--version"] = CommandOutput(status: 0, stdout: version + "\n")
            runner.spawnVersion = version
        }
        update(to: "0.20.0")
        clock.advance(301)
        await c.refresh()
        #expect(runner.spawns.count == 2)

        // Another update inside the 30-minute cooldown waits for it to end.
        update(to: "0.21.0")
        for _ in 0..<4 {
            clock.advance(301)
            await c.refresh()
        }
        #expect(runner.spawns.count == 2)
        for _ in 0..<3 {
            clock.advance(301)
            await c.refresh()
        }
        #expect(runner.spawns.count == 3)
        #expect(c.state.isConnected)
    }

    @Test func restartIsRetriedWhenTheRecheckCannotTell() async {
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        // The poll sees 0.20.0; the re-check in `start()` cannot tell, so
        // the child is kept.
        var versionCalls = 0
        runner.onRun = { [runner] argv in
            guard argv.contains("--version") else { return }
            versionCalls += 1
            runner.outputs["--version"] = versionCalls == 1
                ? CommandOutput(status: 0, stdout: "0.20.0\n") : CommandOutput(status: 1)
        }
        clock.advance(301)
        await c.refresh()
        #expect(runner.spawns.count == 1)

        // The next check restarts: the kept child did not use up 0.20.0.
        runner.onRun = nil
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.20.0\n")
        runner.spawnVersion = "0.20.0"
        clock.advance(301)
        await c.refresh()
        #expect(runner.spawns.count == 2)
    }

    @Test func slowVersionCheckDoesNotRestart() async {
        server.set(port: 47931, status: 200)
        let c = controller(versionTimeout: 0.1)
        await c.connect()
        // A shim keeps `--version` open far past its own timeout.
        runner.outputs["--version"] = CommandOutput(status: 0, stdout: "0.20.0\n")
        runner.delays["--version"] = 1
        clock.advance(301)
        let started = Date()
        await c.refresh()
        #expect(Date().timeIntervalSince(started) < 5)
        #expect(runner.spawns.count == 1)
    }
}
