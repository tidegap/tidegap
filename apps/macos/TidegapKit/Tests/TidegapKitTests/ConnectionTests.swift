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

    func controller() -> ConnectionController {
        let live = runner.live
        let discovery = Discovery(tidegapHome: home, isAlive: { live.contains($0) })
        let launcher = ServerLauncher(
            runner: runner, discovery: discovery,
            loginShell: { (path: "/usr/bin", tidegap: "/opt/homebrew/bin/tidegap") },
            isExecutable: { $0 == "/opt/homebrew/bin/tidegap" },
            startTimeout: 1, pollInterval: 0.01,
            inspector: processes.inspector, startedAt: appStart, killGrace: 0.05
        )
        let transport = server.transport
        return ConnectionController(
            store: TokenStore(directory: support), launcher: launcher,
            makeClient: { APIClient(port: $0, token: $1, transport: transport) }
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
        // The bug: launchd adopted yesterday's server after the app updated.
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

    @Test func foreignProcessOnThePidIsLeftAlone() async {
        runner.live.add(4242)
        processes.set(4242, argv: ["/Applications/Safari.app/Contents/MacOS/Safari"], parent: 1)
        writeDiscovery(home: home, pid: 4242, port: 47999, cliVersion: "0.18.0")
        server.set(port: 47999, status: 200)
        server.set(port: 47931, status: 200)
        let c = controller()
        await c.connect()
        #expect(processes.signals.isEmpty)
        #expect(runner.live.contains(4242))
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
}
