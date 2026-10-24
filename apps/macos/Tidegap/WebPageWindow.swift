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
                WebPage(url: url, start: model.pageURL(view: request?.view) ?? url, request: request)
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
struct WebPage: NSViewRepresentable {
    let url: URL
    let start: URL
    let request: PageViewRequest?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        context.coordinator.server = url
        context.coordinator.applied = request?.id
        context.coordinator.pendingHash = request?.view.value
        view.load(URLRequest(url: start))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        if coordinator.server != url {
            coordinator.server = url
            coordinator.applied = request?.id
            coordinator.pendingHash = request?.view.value
            view.load(URLRequest(url: start))
            return
        }
        // No view asked for ("Open Tidegap"): drop a job view still waiting on the load.
        guard let request else {
            coordinator.pendingHash = nil
            return
        }
        guard request.id != coordinator.applied else { return }
        coordinator.applied = request.id
        // Mid-load, the page's own token step would replace the hash: wait for didFinish.
        if view.isLoading {
            coordinator.pendingHash = request.view.value
        } else {
            Coordinator.setHash(view, request.view.value)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var server: URL?
        var applied: Int?
        /// The view to route to once a fresh load finished. The page's
        /// `&view=` allow-list may not know a job view yet; the hash does.
        var pendingHash: String?

        /// The value comes from `PageView`, never from the page.
        static func setHash(_ webView: WKWebView, _ value: String) {
            webView.evaluateJavaScript("location.hash = '#/\(value)'")
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard let value = pendingHash else { return }
            pendingHash = nil
            Self.setHash(webView, value)
        }

        // A failed load drops the waiting view, so a later reload does not reopen it.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            pendingHash = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            pendingHash = nil
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
