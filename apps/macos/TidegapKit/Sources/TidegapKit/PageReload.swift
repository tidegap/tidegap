import Foundation

/// Reloads of the page window. The page reads its token from the `#token=`
/// fragment, keeps it in memory only and removes it from the address, so a
/// plain reload loses it. The window replaces such a reload with a load of a
/// fresh link and sets the previous view again once that load finished. The
/// page reports a lost token with the script message `expired`; the window
/// answers with a fresh link, at most once per `Guard.interval`.
public enum PageReload {
    /// The longest view the window sets again; a longer address opens the Agenda.
    public static let maxViewLength = 256

    /// True for a URL of the `tidegap ui` server that `server` (the page link) names.
    public static func isServer(_ url: URL?, server: URL?) -> Bool {
        guard let url else { return false }
        return isServer(scheme: url.scheme, host: url.host, port: url.port, server: server)
    }

    private static func isServer(scheme: String?, host: String?, port: Int?, server: URL?) -> Bool {
        guard let server else { return false }
        return scheme == "http" && host == server.host && port == server.port
    }

    /// True for a reload the window replaces with a fresh link: a reload of
    /// the server page without `#token=`. A reload with it is the page's own,
    /// after it got a new link, and goes through.
    public static func replacesReload(of url: URL?, isReload: Bool, server: URL?) -> Bool {
        guard isReload, let url, isServer(url, server: server) else { return false }
        return !(encodedFragment(url)?.hasPrefix("token=") ?? false)
    }

    /// The view to set again after a fresh link: `task/t-1` from `#/task/t-1`.
    /// Nil for any other address, an empty view, a view over `maxViewLength`,
    /// or one with a character outside letters, digits and `/ _ ~ . - ? = & ,`:
    /// the value goes into a script string, so it never carries a quote or a
    /// backslash.
    public static func restoredView(_ url: URL?) -> String? {
        guard let url, let fragment = encodedFragment(url), fragment.hasPrefix("/") else { return nil }
        let view = fragment.dropFirst()
        guard (1...maxViewLength).contains(view.count), view.allSatisfy(viewCharacters.contains) else { return nil }
        return String(view)
    }

    private static let viewCharacters = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_~.-?=&,")

    private static func encodedFragment(_ url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedFragment
    }

    /// True for the page's lost-token message: the exact string `expired`,
    /// posted from the main frame of the server's origin.
    public static func isExpiredMessage(
        _ body: Any, isMainFrame: Bool, scheme: String, host: String, port: Int, server: URL?
    ) -> Bool {
        isMainFrame && body as? String == "expired" && isServer(scheme: scheme, host: host, port: port, server: server)
    }

    /// The answer to `expired`. A fresh link less than `interval` old that
    /// the page still reports lost means the server refuses the token: the
    /// window checks the connection, whose 401 shows Reconnect, instead of
    /// loading again.
    public struct Guard {
        public enum Answer: Equatable {
            case freshLink
            case checkConnection
        }

        public static let interval: TimeInterval = 30

        private let now: () -> Date
        private var lastFreshLink: Date?

        public init(now: @escaping () -> Date = Date.init) {
            self.now = now
        }

        /// Call on every load of a fresh link: the first load, a port change, a replaced reload.
        public mutating func freshLinkLoaded() {
            lastFreshLink = now()
        }

        public func answer() -> Answer {
            guard let last = lastFreshLink, now().timeIntervalSince(last) < Self.interval else { return .freshLink }
            return .checkConnection
        }
    }
}
