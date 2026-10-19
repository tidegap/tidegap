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
        view.load(URLRequest(url: start))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        if coordinator.server != url {
            coordinator.server = url
            coordinator.applied = request?.id
            view.load(URLRequest(url: start))
            return
        }
        guard let request, request.id != coordinator.applied else { return }
        coordinator.applied = request.id
        // The view name comes from a fixed enum, never from the page.
        view.evaluateJavaScript("location.hash = '#/\(request.view.rawValue)'")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var server: URL?
        var applied: Int?

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
