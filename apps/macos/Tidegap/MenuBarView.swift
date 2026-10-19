import SwiftUI
import TidegapKit

/// The menu bar window: clean window header, the Claude limit line, the readiness line, up to 10
/// active tasks with Later, Cancel and Run now, and the app commands. It
/// never creates tasks: agents do.
struct MenuBarView: View {
    @Environment(AppModel.self) private var model
    /// The row waiting for "Yes" on Cancel or Run now.
    @State private var confirming: (taskId: String, action: TaskAction)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider()
            if model.state.isConnected {
                taskList
                Divider()
            }
            commands
        }
        .padding(12)
        .frame(width: 340)
        .onDisappear {
            model.clearActionMessage()
            confirming = nil
        }
    }

    @ViewBuilder private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(headline).font(.headline)
            if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            if model.state.isConnected, let limits = model.summary?.limitsLine {
                Text(limits).font(.caption).monospacedDigit().foregroundStyle(.secondary)
            }
        }
        if model.state.isConnected, let line = model.summary?.notReadyLine {
            Label(line, systemImage: "exclamationmark.triangle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
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

    private var headline: String {
        switch model.state {
        case .connecting: return "Connecting to tidegap ui…"
        case .connected: return model.summary.map { Format.header($0) } ?? "Connected"
        case .offline: return "tidegap ui is not reachable"
        case .revoked: return "Access revoked"
        case .needsUpdate: return "Update tidegap to 0.19 or later"
        case .tidegapNotFound: return "tidegap not found"
        case .failed(let message): return message
        }
    }

    private var detail: String? {
        switch model.state {
        case .connected:
            guard let s = model.summary else { return nil }
            var parts = ["\(s.active) active"]
            if s.counts.running > 0 { parts.append("\(s.counts.running) running") }
            if s.unread > 0 { parts.append("\(s.unread) unread") }
            return parts.joined(separator: " · ")
        case .revoked: return "The token was revoked or removed. Reconnect creates a new one."
        case .needsUpdate(let version): return "Found \(version). Or point Settings at a newer build."
        case .tidegapNotFound: return "Set the tidegap command in Settings."
        case .offline(let message): return message
        default: return nil
        }
    }

    @ViewBuilder private var taskList: some View {
        if let message = model.actionMessage {
            Text(message).font(.caption).foregroundStyle(model.actionFailed ? .red : .secondary).lineLimit(2)
        }
        if model.tasks.isEmpty {
            Text("No tasks queued. Ask your agent to schedule one.").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(model.tasks.prefix(10)) { task in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(task.label).lineLimit(1).truncationMode(.tail)
                            Spacer(minLength: 8)
                            Text(task.status.rawValue).font(.caption).foregroundStyle(.secondary)
                            Text(Format.rowTime(task, now: Date())).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            actionsMenu(task)
                        }
                        if let pending = confirming, pending.taskId == task.taskId {
                            confirmRow(task, pending.action)
                        }
                    }
                }
            }
        }
    }

    /// Later (presets with their times; unavailable ones disabled with the
    /// reason as text), Cancel…, Run now…, each enabled per `actions`.
    private func actionsMenu(_ task: TaskItem) -> some View {
        Menu {
            if let options = task.laterOptions {
                Menu("Later") {
                    ForEach(options) { option in
                        Button(Format.laterItem(option, now: Date())) {
                            run(.later, task, .preset(option.preset))
                        }
                        .disabled(!option.available)
                    }
                }
                .disabled(!task.canPostpone)
            }
            Button("Cancel…") { confirming = (task.taskId, .cancel) }
                .disabled(!task.canCancel)
            Button("Run now…") { confirming = (task.taskId, .runNow) }
                .disabled(!task.canRunNow)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(model.acting)
        .help("Later, Cancel, Run now")
    }

    private func confirmRow(_ task: TaskItem, _ action: TaskAction) -> some View {
        HStack(spacing: 6) {
            Text(action.confirmQuestion ?? "").font(.caption)
            Spacer()
            Button(action == .cancel ? "Keep" : "Not now") { confirming = nil }
                .controlSize(.small)
            Button(action == .cancel ? "Yes, cancel" : "Yes, run now") { run(action, task, nil) }
                .controlSize(.small)
                .keyboardShortcut(.defaultAction)
                .disabled(model.acting)
        }
    }

    private func run(_ action: TaskAction, _ task: TaskItem, _ choice: LaterChoice?) {
        confirming = nil
        Task { await model.perform(action, on: task, later: choice) }
    }

    @ViewBuilder private var commands: some View {
        HStack {
            Button("Open Tidegap window") { model.showWindow() }
            Button("Integrations…") { model.showIntegrations() }
            SettingsLink { Text("Settings…") }
                .simultaneousGesture(TapGesture().onEnded { NSApp.activate(ignoringOtherApps: true) })
            Spacer()
            Button("Quit Tidegap") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
    }
}
