import Foundation

/// Page window load errors (KTD5).
public enum PageLoad {
    /// True for a load that a newer one cancelled (a port change reloads the
    /// page). It is no failure: the newer load still applies the view request.
    public static func isCancelled(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled
    }
}
