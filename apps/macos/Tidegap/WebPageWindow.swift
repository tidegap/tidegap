import AppKit
import SwiftUI
import TidegapKit
import WebKit

/// The full `tidegap ui` page (R12) in a `WKWebView` with a non-persistent
/// data store. The client token goes in the fragment, which the page reads
/// and keeps in memory. Links that leave the server open in the default browser.
struct WebPageWindow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let url = model.pageURL {
                let request = model.viewRequest
                WebPage(url: url, start: model.pageURL(view: request?.view) ?? url, request: request) { [model] id in
                    model.viewApplied(id)
                }
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
struct WebPage: NSViewRepresentable {
    let url: URL
    let start: URL
    let request: PageViewRequest?
    let onApplied: @MainActor (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        let coordinator = context.coordinator
        coordinator.onApplied = onApplied
        coordinator.server = url
        coordinator.applied = request?.id
        coordinator.pending = request
        view.load(URLRequest(url: start))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onApplied = onApplied
        if coordinator.server != url {
            coordinator.server = url
            coordinator.applied = request?.id
            coordinator.pending = request
            view.load(URLRequest(url: start))
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

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var server: URL?
        var applied: Int?
        /// The request to route to once a fresh load finished. The page's
        /// `&view=` allow-list may not know a job view yet; the hash does.
        var pending: PageViewRequest?
        var onApplied: @MainActor (Int) -> Void = { _ in }

        /// The value comes from `PageView`, never from the page.
        static func setHash(_ webView: WKWebView, _ value: String) {
            webView.evaluateJavaScript("location.hash = '#/\(value)'")
        }

        /// Tells the model after the current view update, never during it.
        func report(_ id: Int) {
            let onApplied = onApplied
            DispatchQueue.main.async { MainActor.assumeIsolated { onApplied(id) } }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard let request = pending else { return }
            pending = nil
            Self.setHash(webView, request.view.value)
            report(request.id)
        }

        /// A failed load drops the waiting view, so a later reload does not
        /// reopen it. A load that a newer one cancelled (a port change) keeps
        /// it: the newer load applies it.
        private func loadFailed(_ error: Error) {
            guard !PageLoad.isCancelled(error), let request = pending else { return }
            pending = nil
            report(request.id)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            loadFailed(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            loadFailed(error)
        }

        private func isServer(_ url: URL?) -> Bool {
            guard let url, let server else { return false }
            return url.scheme == "http" && url.host == server.host && url.port == server.port
        }

        func webView(
            _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            if isServer(action.request.url) || action.request.url?.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
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
