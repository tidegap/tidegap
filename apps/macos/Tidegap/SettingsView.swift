import AppKit
import SwiftUI
import TidegapKit

/// The `tidegap` command override, the port, launch at login, notifications
/// and the connection (KTD12, U17).
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(SettingsKey.command) private var command = ""
    @AppStorage(SettingsKey.port) private var port = 0
    @AppStorage(SettingsKey.notifyFinished) private var notifyFinished = true
    @AppStorage(SettingsKey.notifyCleanWindow) private var notifyCleanWindow = true

    var body: some View {
        Form {
            Section("tidegap") {
                TextField("Command", text: $command, prompt: Text("tidegap (found automatically)"))
                Text("Arguments split on spaces; quote paths with spaces. For a repo build: node /path/to/tidegap/packages/cli/dist/index.js")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("Port", value: $port, format: .number.grouping(.never), prompt: Text("47821"))
                Text("Port for a server this app starts. 0 or empty: the default. A running server is found through ~/.tidegap/ui.json.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("App") {
                Toggle("Launch at login", isOn: Binding(
                    get: { launchAtLogin.isOn },
                    set: { launchAtLogin.set($0) }
                ))
                if let message = launchAtLogin.message {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
                if launchAtLogin.status == .requiresApproval {
                    Button("Open Login Items") { launchAtLogin.openSystemSettings() }
                }
            }
            Section("Notifications") {
                Toggle("A task finishes", isOn: $notifyFinished)
                Toggle("A clean window starts", isOn: $notifyCleanWindow)
            }
            Section("Connection") {
                Text(status).textSelection(.enabled)
                HStack {
                    Button("Apply and retry") { model.retry() }
                    Button("Reconnect") { model.reconnect() }
                        .help("Creates a new client token. The only way back after a revoke.")
                    Button("Forget token", role: .destructive) { model.forgetToken() }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { launchAtLogin.refresh() }
        // Back from System Settings: the toggle follows an approval made there.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            launchAtLogin.refresh()
        }
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var launchAtLogin: LaunchAtLogin { model.launchAtLogin }

    private var status: String {
        switch model.state {
        case .connecting: return "Connecting…"
        case .connected(let port, let owns):
            return "Connected to 127.0.0.1:\(port)" + (owns ? ", a server this app started" : "")
        case .offline(let message): return message
        case .revoked: return "No token. Reconnect creates a new one."
        case .needsUpdate(let version): return "tidegap \(version) is too old. Update to 0.19 or later, or set the command above."
        case .tidegapNotFound: return "tidegap not found. Set the command above."
        case .failed(let message): return message
        }
    }
}
