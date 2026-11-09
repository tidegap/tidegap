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
        coordinator.run(coordinator.routing.serverChanged(link: url, start: start, request: routed), on: view)
        return view
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.messageHandler)
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onApplied = onApplied
        coordinator.onRefused = onRefused
        if coordinator.routing.server != url {
            coordinator.run(coordinator.routing.serverChanged(link: url, start: start, request: routed), on: view)
        } else {
            // Mid-load, the page's own token step would replace the hash: the request waits for didFinish.
            coordinator.run(coordinator.routing.request(routed, isLoading: view.isLoading), on: view)
        }
    }

    private var routed: PageRouting.Request? {
        request.map { PageRouting.Request(id: $0.id, view: $0.view.value) }
    }

    /// Runs the WebKit calls; the decisions are `PageRouting`'s.
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        /// The script message handler the page posts `expired` to.
        static let messageHandler = "tidegap"

        var routing = PageRouting()
        var onApplied: @MainActor (Int) -> Void = { _ in }
        var onRefused: @MainActor () -> Void = {}
        private var reloads = PageReload.Guard()
        /// The main-frame response of the current load was a server error (400 or more).
        private var isErrorPage = false

        func run(_ actions: [PageRouting.Action], on webView: WKWebView) {
            for action in actions {
                switch action {
                case .load(let link):
                    // Notes the time for the `expired` guard.
                    reloads.freshLinkLoaded()
                    webView.load(URLRequest(url: link))
                case .setHash(let view, let id):
                    setHash(webView, view, request: id)
                case .report(let id):
                    report(id)
                }
            }
        }

        /// Opens `#/<value>` once the page read its token. WebKit can report
        /// `didFinish` before the page's module script ran; a hash set then
        /// would replace `#token=` and the page would boot without it. A
        /// complete page (its module script ran) that still shows `#token=`
        /// reloads itself for the new link, so the request waits for that
        /// load. The value
        /// comes from `PageView` or `PageReload.restoredView`, never from
        /// the page, so it carries no quote or backslash.
        private func setHash(_ webView: WKWebView, _ value: String, request id: Int?) {
            webView.evaluateJavaScript("""
                (() => {
                  const open = () => { location.hash = '#/\(value)'; };
                  if (!/^#token=/.test(location.hash)) { open(); return 'set'; }
                  if (document.readyState === 'complete') return 'reload';
                  addEventListener('DOMContentLoaded', open, { once: true });
                  return 'later';
                })()
                """) { [weak self, weak webView] result, _ in
                guard let self, let webView else { return }
                let done = (result as? String).flatMap(PageRouting.HashResult.init(rawValue:))
                self.run(self.routing.hashResult(id: id, done), on: webView)
            }
        }

        /// Tells the model after the current view update, never during it.
        private func report(_ id: Int) {
            let onApplied = onApplied
            DispatchQueue.main.async { MainActor.assumeIsolated { onApplied(id) } }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            isErrorPage = false
        }

        func webView(
            _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
            decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
        ) {
            if response.isForMainFrame {
                isErrorPage = ((response.response as? HTTPURLResponse)?.statusCode ?? 0) >= 400
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            run(routing.finished(isErrorPage: isErrorPage), on: webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            run(routing.failed(cancelled: PageLoad.isCancelled(error)), on: webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            run(routing.failed(cancelled: PageLoad.isCancelled(error)), on: webView)
        }

        func webView(
            _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            let url = action.request.url
            if let server = routing.server, action.targetFrame?.isMainFrame == true,
               PageReload.replacesReload(of: url, isReload: action.navigationType == .reload, server: server) {
                decisionHandler(.cancel)
                run(routing.freshLink(restoring: PageReload.restoredView(url)), on: webView)
                return
            }
            if PageReload.isServer(url, server: routing.server) || url?.scheme == "about" {
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
                scheme: origin.protocol, host: origin.host, port: origin.port, server: routing.server
            ), let webView = message.webView else { return }
            switch reloads.answer() {
            case .freshLink:
                run(routing.freshLink(restoring: PageReload.restoredView(webView.url)), on: webView)
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
