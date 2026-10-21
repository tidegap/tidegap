import Foundation

/// Where the app stands with `tidegap ui` (the connect sequence in the plan's
/// High-Level Technical Design).
public enum ConnectionState: Equatable, Sendable {
    case connecting
    /// `ownsServer` is true when this app started the server.
    case connected(port: Int, ownsServer: Bool)
    /// No server answers, and none could be started.
    case offline(String)
    /// A 401, or the user forgot the token. Only Reconnect mints again.
    case revoked
    /// The `tidegap` CLI is older than 0.19 and has no `clients` command.
    case needsUpdate(version: String)
    case tidegapNotFound
    case failed(String)

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    /// True when the app holds no usable token (badge "?", KTD6).
    public var lacksToken: Bool {
        switch self {
        case .revoked, .needsUpdate, .tidegapNotFound: return true
        default: return false
        }
    }
}

/// Runs the connect sequence: token, discovery, spawn, summary; drops the
/// token on 401 and re-runs discovery after two failed polls (R13, KTD12).
@MainActor
public final class ConnectionController {
    public typealias ClientFactory = (_ port: Int, _ token: String) -> APIClient

    public private(set) var state: ConnectionState = .connecting
    public private(set) var summary: Summary?
    public private(set) var token: String?

    /// Called after every state or summary change.
    public var onChange: (() -> Void)?
    /// Called with each new summary, before `onChange`.
    public var onSummary: ((Summary) -> Void)?
    /// The `since` cursor for the next summary call (nil on the first call).
    public var cursor: () -> String? = { nil }

    private let store: TokenStore
    public let launcher: ServerLauncher
    private let makeClient: ClientFactory
    private var attached: (port: Int, owns: Bool)?
    private var failedPolls = 0
    private var busy = false
    /// A refresh asked for while another ran; it runs once afterwards.
    private var refreshPending = false
    /// A connect or Reconnect asked for while a poll ran; it runs afterwards.
    private var connectPending = false

    public init(
        store: TokenStore,
        launcher: ServerLauncher,
        makeClient: @escaping ClientFactory = { APIClient(port: $0, token: $1) }
    ) {
        self.store = store
        self.launcher = launcher
        self.makeClient = makeClient
    }

    /// A client for the attached server, through the same factory as polling.
    public func client() -> APIClient? {
        guard let attached, let token else { return nil }
        return makeClient(attached.port, token)
    }

    /// The server port while one is attached, reachable or not.
    public var port: Int? { attached?.port }

    /// The token, the server, then the first summary. Mints only when no token
    /// is stored and no revoke is recorded.
    public func connect() async {
        guard !busy else {
            connectPending = true
            return
        }
        repeat {
            connectPending = false
            await connectOnce()
        } while connectPending
    }

    private func connectOnce() async {
        busy = true
        defer { busy = false }
        set(.connecting)
        guard let token = await ensureToken() else { return }
        self.token = token
        await attach(token: token)
    }

    /// The only path that mints after a 401 or "Forget token".
    public func reconnect() async {
        store.delete()
        store.clearRevoked()
        token = nil
        await connect()
    }

    /// Deletes the stored token; the app waits for Reconnect.
    public func forgetToken() {
        dropToken()
    }

    /// One poll: the summary. Two failed polls in a row run
    /// discovery and the spawn branch again.
    public func refresh() async {
        guard !busy else {
            refreshPending = true
            return
        }
        await refreshOnce()
        while refreshPending {
            refreshPending = false
            await refreshOnce()
        }
        if connectPending { await connect() }
    }

    private func refreshOnce() async {
        guard let token else {
            if !state.lacksToken { await connect() }
            return
        }
        busy = true
        defer { busy = false }
        guard let attached else {
            await attach(token: token)
            return
        }
        if await fetch(port: attached.port, token: token) { return }
        guard case .offline = state else { return }
        failedPolls += 1
        if failedPolls >= 2 {
            failedPolls = 0
            self.attached = nil
            await attach(token: token)
        }
    }

    /// Stops the child this app started, and nothing else (AE5).
    public func shutdown() {
        launcher.stop()
    }

    private func ensureToken() async -> String? {
        if let token = store.read() { return token }
        if store.isRevoked {
            set(.revoked)
            return nil
        }
        do {
            let token = try await TokenMinter.mint(with: launcher)
            try store.write(token)
            store.clearRevoked()
            return token
        } catch MintError.needsUpdate(let version) {
            set(.needsUpdate(version: version))
        } catch LaunchError.tidegapNotFound {
            set(.tidegapNotFound)
        } catch MintError.failed(let message) {
            set(.failed(message))
        } catch {
            set(.failed(String(describing: error)))
        }
        return nil
    }

    /// A live `ui.json` server that passes `ServerVetting` first; when it is
    /// absent, replaced, foreign or refuses the connection, the app's own child.
    private func attach(token: String) async {
        if let found = await launcher.adoptableServer() {
            attached = (found.port, false)
            if await fetch(port: found.port, token: token) { return }
            guard case .offline = state else { return }
            attached = nil
        }
        do {
            let started = try await launcher.start()
            attached = (started.port, true)
            _ = await fetch(port: started.port, token: token)
        } catch LaunchError.tidegapNotFound {
            set(.tidegapNotFound)
        } catch {
            set(.offline("could not start tidegap ui"))
        }
    }

    /// True on success. Sets `.offline`, `.revoked` or `.failed` otherwise.
    private func fetch(port: Int, token: String) async -> Bool {
        let client = makeClient(port, token)
        let result = await client.summary(since: cursor())
        // Reconnect or Forget token ran meanwhile: this answer is stale.
        guard self.token == token else { return false }
        switch result {
        case .ok(let summary):
            failedPolls = 0
            self.summary = summary
            state = .connected(port: port, ownsServer: attached?.owns ?? false)
            onSummary?(summary)
            onChange?()
            return true
        case .offline:
            set(.offline("tidegap ui is not reachable"))
        case .unpaired:
            dropToken()
        case .error(let message):
            set(.failed(message))
        }
        return false
    }

    private func dropToken() {
        store.delete()
        store.markRevoked()
        token = nil
        summary = nil
        set(.revoked)
    }

    private func set(_ state: ConnectionState) {
        self.state = state
        onChange?()
    }
}
