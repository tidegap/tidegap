import AppKit
import SwiftUI
import TidegapKit
import WebKit

/// The full `tidegap ui` page (R12) in a `WKWebView` with a non-persistent
/// data store. The client token goes in the fragment, which the page reads
/// and keeps in memory, so every reload loads a fresh link (`PageReload`).
/// Links that leave the server open in the default browser.
struct WebPageWindow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let url = model.pageURL {
                let request = model.viewRequest
                WebPage(
                    url: url, start: model.pageURL(view: request?.view) ?? url, request: request,
                    onApplied: { [model] id in model.viewApplied(id) },
                    onRefused: { [model] in model.refresh() }
                )
            } else {
                notConnected
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 720, minHeight: 520)
    }

    /// The connection state and its fix, in place of the page.
    private var notConnected: some View {
        VStack(spacing: 8) {
            Text(Format.headline(state: model.state, summary: model.summary)).font(.headline)
            if let detail = Format.detail(state: model.state, summary: model.summary) {
                Text(detail).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            switch model.state {
            case .revoked:
                Button("Reconnect") { model.reconnect() }
            case .offline, .failed, .tidegapNotFound, .needsUpdate:
                Button("Retry") { model.retry() }
            default:
                EmptyView()
            }
        }
        .padding()
    }
}

/// `url` is the page link (a new one reloads); `start` is what a new load
/// opens (the link plus `&view=`). A view request on a loaded page sets
/// its hash, so a repeated "Integrations…" works after the user moved on.
/// `onApplied` reports a request once its hash is set (or its load failed),
/// so the model can drop it and a recreated window does not reopen it.
/// `onRefused` asks the connection to check the token: the page lost it again
/// right after a fresh link, so a 401 there shows Reconnect.
struct WebPage: NSViewRepresentable {
    let url: URL
    let start: URL
    let request: PageViewRequest?
    let onApplied: @MainActor (Int) -> Void
    let onRefused: @MainActor () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let coordinator = context.coordinator
        config.userContentController.add(WeakMessageHandler(coordinator), name: Coordinator.messageHandler)
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = coordinator
        view.uiDelegate = coordinator
        coordinator.onApplied = onApplied
        coordinator.onRefused = onRefused
        coordinator.server = url
        coordinator.applied = request?.id
        coordinator.pending = request
        coordinator.loadFresh(view, start)
        return view
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.messageHandler)
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onApplied = onApplied
        coordinator.onRefused = onRefused
        if coordinator.server != url {
            coordinator.server = url
            coordinator.applied = request?.id
            coordinator.pending = request
            coordinator.restore = nil
            coordinator.loadFresh(view, start)
            return
        }
        // No view asked for. The model clears a request only after this
        // coordinator reported it, and a reported request has nothing pending,
        // so a view still waiting here was dropped by "Open Tidegap": drop it too.
        guard let request else {
            coordinator.pending = nil
            return
        }
        guard request.id != coordinator.applied else { return }
        coordinator.applied = request.id
        // Mid-load, the page's own token step would replace the hash: wait for didFinish.
        if view.isLoading {
            coordinator.pending = request
        } else {
            coordinator.pending = nil
            Coordinator.setHash(view, request.view.value)
            coordinator.report(request.id)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        /// The script message handler the page posts `expired` to.
        static let messageHandler = "tidegap"

        /// The page link: the server's address with the client token in the fragment.
        var server: URL?
        var applied: Int?
        /// The request to route to once a fresh load finished. The page's
        /// `&view=` allow-list may not know a job view yet; the hash does.
        var pending: PageViewRequest?
        /// The view a replaced reload showed, set again once the fresh link
        /// finished. A pending request wins over it.
        var restore: String?
        var onApplied: @MainActor (Int) -> Void = { _ in }
        var onRefused: @MainActor () -> Void = {}
        private var reloads = PageReload.Guard()

        /// Loads a link with the client token and notes the time for the `expired` guard.
        func loadFresh(_ webView: WKWebView, _ link: URL) {
            reloads.freshLinkLoaded()
            webView.load(URLRequest(url: link))
        }

        /// Opens `#/<value>` once the page read its token. WebKit can report
        /// `didFinish` before the page's module script ran; a hash set then
        /// would replace `#token=` and the page would boot without it. The
        /// value comes from `PageView` or `PageReload.restoredView`, never
        /// from the page, so it carries no quote or backslash.
        static func setHash(_ webView: WKWebView, _ value: String) {
            webView.evaluateJavaScript("""
                (() => {
                  const open = () => { location.hash = '#/\(value)'; };
                  if (/^#token=/.test(location.hash)) addEventListener('DOMContentLoaded', open, { once: true });
                  else open();
                })()
                """)
        }

        /// Tells the model after the current view update, never during it.
        func report(_ id: Int) {
            let onApplied = onApplied
            DispatchQueue.main.async { MainActor.assumeIsolated { onApplied(id) } }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            let restored = restore
            restore = nil
            if let request = pending {
                pending = nil
                Self.setHash(webView, request.view.value)
                report(request.id)
            } else if let restored {
                Self.setHash(webView, restored)
            }
        }

        /// A failed load drops the waiting view, so a later reload does not
        /// reopen it. A load that a newer one cancelled (a port change) keeps
        /// it: the newer load applies it.
        private func loadFailed(_ error: Error) {
            guard !PageLoad.isCancelled(error) else { return }
            restore = nil
            guard let request = pending else { return }
            pending = nil
            report(request.id)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            loadFailed(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            loadFailed(error)
        }

        func webView(
            _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            let url = action.request.url
            if let server, action.targetFrame?.isMainFrame == true,
               PageReload.replacesReload(of: url, isReload: action.navigationType == .reload, server: server) {
                decisionHandler(.cancel)
                restore = PageReload.restoredView(url)
                loadFresh(webView, server)
                return
            }
            if PageReload.isServer(url, server: server) || url?.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        /// The page lost its token (`expired`, no data, no reply): a fresh
        /// link, or a connection check when the last one is too recent.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard PageReload.isExpiredMessage(
                message.body, isMainFrame: message.frameInfo.isMainFrame,
                scheme: origin.protocol, host: origin.host, port: origin.port, server: server
            ), let webView = message.webView, let server else { return }
            switch reloads.answer() {
            case .freshLink:
                restore = PageReload.restoredView(webView.url)
                loadFresh(webView, server)
            case .checkConnection:
                onRefused()
            }
        }

        /// `target="_blank"` links: the default browser, never a new web view.
        func webView(
            _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
            for action: WKNavigationAction, windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
    }
}

/// A script message handler that keeps its target weakly, so the web view's
/// content controller does not keep the coordinator alive.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
