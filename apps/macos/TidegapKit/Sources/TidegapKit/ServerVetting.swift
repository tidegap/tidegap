import Darwin
import Foundation

/// Reads another process's argv, parent and start time, and signals it. A
/// struct of closures, so tests can describe processes that do not exist.
public struct ProcessInspector: Sendable {
    public var arguments: @Sendable (Int32) -> [String]?
    public var parent: @Sendable (Int32) -> Int32?
    /// Kernel start time (seconds since 1970). With argv it tells a process
    /// from a later one that got the same pid.
    public var startTime: @Sendable (Int32) -> TimeInterval?
    public var signal: @Sendable (Int32, Int32) -> Void

    public init(
        arguments: @escaping @Sendable (Int32) -> [String]?,
        parent: @escaping @Sendable (Int32) -> Int32?,
        startTime: @escaping @Sendable (Int32) -> TimeInterval?,
        signal: @escaping @Sendable (Int32, Int32) -> Void
    ) {
        self.arguments = arguments
        self.parent = parent
        self.startTime = startTime
        self.signal = signal
    }

    public static let system = ProcessInspector(
        arguments: systemArguments,
        parent: { systemInfo($0)?.kp_eproc.e_ppid },
        startTime: { pid in
            systemInfo(pid).map { info in
                let t = info.kp_proc.p_un.__p_starttime
                return TimeInterval(t.tv_sec) + TimeInterval(t.tv_usec) / 1_000_000
            }
        },
        signal: { pid, sig in
            // Never launchd, a process group (pid <= 0) or the app itself.
            guard ServerVetting.isSignallable(pid) else { return }
            _ = kill(pid, sig)
        }
    )

    /// `KERN_PROCARGS2`: argc, the exec path, padding, then argv. nil for a
    /// process of another user or one that is gone.
    static func systemArguments(_ pid: Int32) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        let argc = buf.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        var i = MemoryLayout<Int32>.size
        while i < size, buf[i] != 0 { i += 1 }
        while i < size, buf[i] == 0 { i += 1 }
        var args: [String] = []
        while args.count < argc, i < size {
            let start = i
            while i < size, buf[i] != 0 { i += 1 }
            args.append(String(decoding: buf[start..<i], as: UTF8.self))
            i += 1
        }
        return args
    }

    static func systemInfo(_ pid: Int32) -> kinfo_proc? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        // A gone pid returns 0 with size 0.
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info
    }
}

/// What the app does with a live server named by `ui.json`.
public enum ServerVerdict: Equatable, Sendable {
    /// A current `tidegap ui`: attach to it.
    case reuse
    /// A `tidegap ui` with old code, or an orphan of an earlier app run:
    /// terminate it and start a new one.
    case replace(String)
    /// The pid now belongs to another program: leave it alone, start our own.
    case foreign
}

public enum ServerVetting {
    /// A pid the app may signal: not launchd, not a process group, not itself.
    public static func isSignallable(_ pid: Int32) -> Bool {
        pid > 1 && pid != getpid()
    }

    /// True when argv runs `tidegap ui`: an argument named `index.js` or
    /// `tidegap` (the npm bin link) followed by `ui`.
    public static func isTidegapUI(_ argv: [String]) -> Bool {
        zip(argv, argv.dropFirst()).contains { script, command in
            let name = (script as NSString).lastPathComponent
            return (name == "index.js" || name == "tidegap") && command == "ui"
        }
    }

    /// The decision table. `currentVersion` is what `tidegap --version` of
    /// the command the app would launch prints; nil skips the version rule.
    public static func verdict(
        record: DiscoveryRecord,
        argv: [String]?,
        parent: Int32?,
        currentVersion: String?,
        appStartedAt: Date
    ) -> ServerVerdict {
        guard let argv, isTidegapUI(argv) else { return .foreign }
        if let currentVersion, record.cliVersion != currentVersion {
            return .replace("version \(record.cliVersion ?? "unknown"), expected \(currentVersion)")
        }
        // Parent 1: launchd adopted it, so the app that started it is gone.
        if parent == 1 {
            let started = record.startedAt.flatMap(Wire.parseDate)
            if started.map({ $0 < appStartedAt }) ?? true { return .replace("orphan of an earlier run") }
        }
        return .reuse
    }
}
