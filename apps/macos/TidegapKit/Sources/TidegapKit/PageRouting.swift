import Foundation

/// The page window's view routing: which view a load opens, when a view
/// request counts as applied, and which view a fresh link sets again. The
/// window forwards each WebKit event and runs the actions that come back.
public struct PageRouting {
    /// A view request: `id` tells a repeated request from the last one.
    public struct Request: Equatable, Sendable {
        public let id: Int
        public let view: String

        public init(id: Int, view: String) {
            self.id = id
            self.view = view
        }
    }

    /// What `setHash` did on the page.
    public enum HashResult: String, Sendable {
        /// The hash is set.
        case set
        /// A listener sets it once the loading document is parsed.
        case later
        /// The document holds a new `#token=` link and reloads itself.
        case reload
    }

    public enum Action: Equatable, Sendable {
        case load(URL)
        /// Sets `#/<view>`; `request` is the request it applies, nil for a restored view.
        case setHash(String, request: Int?)
        /// Tells the model that a request is done.
        case report(Int)
    }

    /// The page link: the server's address with the client token in the fragment.
    public private(set) var server: URL?
    /// The last request taken, so an unchanged one is not applied again.
    private var applied: Int?
    /// The request not yet reported. The page's `&view=` allow-list may not
    /// know a job view yet; the hash does, so a load's finish sets it.
    private var pending: Request?
    /// The view a replaced reload showed, for the fresh link's finish only.
    /// A pending request wins over it.
    private var restore: String?
    /// A fresh link is on its way: a request waits for its finish. WebKit
    /// can run a `setHash` before the link reaches the page, and the
    /// page's reload for the link would then drop that view.
    private var freshLoad = false
    /// The last finish was a server error page, which has no script to
    /// reload itself for a new link.
    private var errorPage = false

    public init() {}

    /// A new page link (the first load or a port change): `start` opens it with the request's view.
    public mutating func serverChanged(link: URL, start: URL, request: Request?) -> [Action] {
        server = link
        applied = request?.id
        pending = request
        restore = nil
        freshLoad = false
        return [.load(start)]
    }

    /// The view the model asks for now. Nil drops a waiting one ("Open Tidegap").
    public mutating func request(_ request: Request?, isLoading: Bool) -> [Action] {
        guard let request else {
            pending = nil
            return []
        }
        guard request.id != applied else { return [] }
        applied = request.id
        pending = request
        return isLoading || freshLoad ? [] : [.setHash(request.view, request: request.id)]
    }

    /// A replaced reload or an `expired` answer: the page link again, without a view.
    public mutating func freshLink(restoring view: String?) -> [Action] {
        restore = view
        guard let server else { return [] }
        freshLoad = !errorPage
        return [.load(server)]
    }

    /// An error page is no page to route on: a pending request ends there
    /// as for a failed load, and the restored view ends with its load.
    public mutating func finished(isErrorPage: Bool) -> [Action] {
        let restored = restore
        restore = nil
        freshLoad = false
        errorPage = isErrorPage
        if let request = pending {
            guard isErrorPage else { return [.setHash(request.view, request: request.id)] }
            pending = nil
            return [.report(request.id)]
        }
        if let restored, !isErrorPage { return [.setHash(restored, request: nil)] }
        return []
    }

    /// A failed load drops the waiting view, so a later reload does not
    /// reopen it. A load that a newer one cancelled (a port change) keeps
    /// it: the newer load applies it.
    public mutating func failed(cancelled: Bool) -> [Action] {
        guard !cancelled else { return [] }
        restore = nil
        freshLoad = false
        guard let request = pending else { return [] }
        pending = nil
        return [.report(request.id)]
    }

    /// The `setHash` result; nil for a failed script call, which counts as
    /// set. On `reload` the request waits for the reloaded page's finish,
    /// except on an error page, which does not reload.
    public mutating func hashResult(id: Int?, _ result: HashResult?) -> [Action] {
        guard result != .reload || errorPage, let id, pending?.id == id else { return [] }
        pending = nil
        return [.report(id)]
    }
}
