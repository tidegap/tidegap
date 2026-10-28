import Foundation

/// Runs a closure on a queue when the process gets one of `signals`, in
/// place of the signal's default action (KTD3). The app installs it for
/// SIGTERM and quits through `NSApp.terminate`, so `killall Tidegap` stops
/// the server the app started, as Quit does.
public final class TerminationSignals {
    private let signals: [Int32]
    private var sources: [DispatchSourceSignal] = []

    /// While the helper lives, each signal is ignored (`SIG_IGN`) and a
    /// dispatch source calls `handler` on `queue`. Signals that arrive
    /// before the handler runs merge into one call.
    public init(_ signals: [Int32], queue: DispatchQueue, handler: @escaping () -> Void) {
        self.signals = signals
        sources = signals.map { sig in
            Darwin.signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            source.setEventHandler(handler: handler)
            source.resume()
            return source
        }
    }

    /// Stops the calls and gives each signal its default action back.
    public func cancel() {
        guard !sources.isEmpty else { return }
        sources.forEach { $0.cancel() }
        sources = []
        signals.forEach { Darwin.signal($0, SIG_DFL) }
    }

    deinit { cancel() }
}
