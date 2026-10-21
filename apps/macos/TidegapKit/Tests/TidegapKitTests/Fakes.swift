import Foundation
@testable import TidegapKit

func tempDir() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("tidegapkit-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func writeDiscovery(
    home: URL, pid: Int32, port: Int,
    cliVersion: String = "0.19.0", startedAt: String = "2026-10-17T09:00:00.000Z"
) {
    let json = #"{"version":1,"pid":\#(pid),"port":\#(port),"url":"http://127.0.0.1:\#(port)/","started_at":"\#(startedAt)","cli_version":"\#(cliVersion)"}"#
    try! Data(json.utf8).write(to: home.appendingPathComponent("ui.json"))
}

final class FakeProcess: RunningProcess {
    let pid: Int32
    var isRunning = true
    var terminated = 0

    init(pid: Int32) { self.pid = pid }

    func terminate() {
        terminated += 1
        isRunning = false
    }
}

/// Records argv and environments; answers `run` from a table keyed by the
/// arguments after the command; `spawn` writes ui.json for its child.
final class FakeRunner: ProcessRunner, @unchecked Sendable {
    var outputs: [String: CommandOutput] = [:]
    var runs: [[String]] = []
    var spawns: [[String]] = []
    var environments: [[String: String]] = []
    var children: [FakeProcess] = []
    var nextPid: Int32 = 70001
    var spawnPort = 47931
    var commandLength = 1
    let home: URL?
    let live: LivePids

    init(home: URL? = nil, live: LivePids = LivePids()) {
        self.home = home
        self.live = live
    }

    /// Runs before each `run` answers, e.g. to change the world mid-vetting.
    var onRun: (([String]) -> Void)?

    func run(_ argv: [String], environment: [String: String]) async throws -> CommandOutput {
        runs.append(argv)
        onRun?(argv)
        environments.append(environment)
        let key = argv.dropFirst(commandLength).joined(separator: " ")
        return outputs[key] ?? CommandOutput(status: 1, stderr: "error: unknown command '\(key)'")
    }

    func spawn(_ argv: [String], environment: [String: String]) throws -> RunningProcess {
        spawns.append(argv)
        environments.append(environment)
        let child = FakeProcess(pid: nextPid)
        nextPid += 1
        children.append(child)
        live.add(child.pid)
        if let home { writeDiscovery(home: home, pid: child.pid, port: spawnPort) }
        return child
    }

    var mintCalls: Int { runs.filter { $0.contains("add") }.count }
}

final class LivePids: @unchecked Sendable {
    private var pids: Set<Int32> = []
    private let lock = NSLock()

    init(_ pids: [Int32] = []) { self.pids = Set(pids) }

    func add(_ pid: Int32) { lock.withLock { _ = pids.insert(pid) } }
    func remove(_ pid: Int32) { lock.withLock { _ = pids.remove(pid) } }
    func contains(_ pid: Int32) -> Bool { lock.withLock { pids.contains(pid) } }
}

/// Process table for `ProcessInspector`: argv and parent per pid, and the
/// signals sent. By default a pid runs `tidegap ui` under a terminal shell.
final class FakeProcesses: @unchecked Sendable {
    private let lock = NSLock()
    private var argv: [Int32: [String]?] = [:]
    private var parents: [Int32: Int32] = [:]
    private var starts: [Int32: TimeInterval] = [:]
    private(set) var signals: [(pid: Int32, sig: Int32)] = []
    /// False: the process ignores SIGTERM, so only SIGKILL ends it.
    var exitsOnTerm = true
    /// Runs after each signal is recorded, e.g. to hand the pid to another process.
    var afterSignal: ((Int32, Int32) -> Void)?
    let live: LivePids

    init(live: LivePids) { self.live = live }

    func set(_ pid: Int32, argv: [String]?, parent: Int32 = 501) {
        lock.withLock {
            self.argv[pid] = argv
            parents[pid] = parent
        }
    }

    /// The pid now belongs to a process that started at `start` (default 1000).
    func setStart(_ pid: Int32, _ start: TimeInterval) {
        lock.withLock { starts[pid] = start }
    }

    var sent: [Int32] { lock.withLock { signals.map(\.sig) } }

    var inspector: ProcessInspector {
        ProcessInspector(
            arguments: { [self] pid in
                lock.withLock { argv[pid] ?? ["/opt/homebrew/bin/node", "/opt/homebrew/bin/tidegap", "ui", "--no-open"] }
            },
            parent: { [self] pid in lock.withLock { parents[pid] ?? 501 } },
            startTime: { [self] pid in lock.withLock { starts[pid] ?? 1000 } },
            signal: { [self] pid, sig in
                let exits = lock.withLock {
                    signals.append((pid, sig))
                    return sig == SIGKILL || exitsOnTerm
                }
                if exits { live.remove(pid) }
                afterSignal?(pid, sig)
            }
        )
    }
}

/// A transport that answers per port, so a test can stop one server.
final class FakeServer: @unchecked Sendable {
    private let lock = NSLock()
    private var status: [Int: Int] = [:]
    private var routes: [String: (Int, String)] = [:]
    private(set) var requests: [URLRequest] = []

    func set(port: Int, status code: Int?) {
        lock.withLock { status[port] = code }
    }

    /// A fixed answer for one path, whatever the port's status.
    func respond(path: String, status code: Int, body: String) {
        lock.withLock { routes[path] = (code, body) }
    }

    var transport: HTTPTransport {
        { [self] request in
            let (portCode, route): (Int?, (Int, String)?) = lock.withLock {
                requests.append(request)
                return (status[request.url?.port ?? 0], routes[request.url?.path ?? ""])
            }
            guard let portCode else { throw URLError(.cannotConnectToHost) }
            let path = request.url?.path ?? ""
            if let (code, body) = route {
                let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil)!
                return (Data(body.utf8), response)
            }
            let code = portCode
            let body: String
            switch (code, path) {
            case (200, "/api/summary"): body = summaryFixture
            case (200, "/api/tasks"): body = #"{"tasks":[]}"#
            case (401, _): body = #"{"error":"unauthorized"}"#
            default: body = #"{"error":"internal error"}"#
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(body.utf8), response)
        }
    }

    var paths: [String] { lock.withLock { requests.compactMap { $0.url?.path } } }
}

func summary(
    active: Int = 0,
    window: CleanWindow? = nil,
    finished: [FinishedTask]? = nil,
    cursor: String = "2026-10-17T10:00:00.000Z",
    region: String? = "FR",
    generatedAt: Date = Wire.parseDate("2026-10-17T10:00:00Z")!,
    readiness: Readiness? = nil,
    limits: Limits? = nil,
    running: Int = 0,
    unread: Int = 0
) -> Summary {
    Summary(
        generatedAt: generatedAt, region: region,
        counts: Counts(queued: active - running, scheduled: 0, running: running, submitted: 0),
        active: active, unread: unread, nextRun: nil, cleanWindow: window,
        forecastOk: window != nil, finished: finished, cursor: cursor, readiness: readiness,
        limits: limits
    )
}

func date(_ iso: String) -> Date { Wire.parseDate(iso)! }
