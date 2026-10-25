import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let task: PhoneTask
    @State private var openAttempt: UUID?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Label(task.targetApp, systemImage: "iphone")
                        .capStyle()
                    Text(task.title)
                        .font(Theme.display(34))
                        .foregroundStyle(Theme.ink)
                    Text(task.summary).foregroundStyle(Theme.inkMuted)
                    TaskMetaRow(task: task, showApp: false)
                }
                .padding(.vertical, 6)
            }
            Section("Before you start") {
                Label(task.startingConditions, systemImage: "flag")
            }
            Section("Steps") {
                StepList(steps: task.steps)
                    .padding(.vertical, 4)
            }
            Section("The recording must show") {
                Label(task.evidence, systemImage: "eye")
                if !task.notes.isEmpty {
                    Label(task.notes, systemImage: "info.circle")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            Section("How to record") {
                RecordingHowTo()
                    .padding(.vertical, 4)
            }
            Section {
                Label {
                    Text("Use test content only. Don't show messages, contacts, photos, or account details you wouldn't want reviewed.")
                } icon: {
                    Image(systemName: "hand.raised.fill").foregroundStyle(Theme.gold)
                }
                .font(.callout)
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button {
                openAttempt = model.startAttempt(for: task).id
            } label: {
                Label(model.openAttempt(for: task) == nil ? "Start task" : "Continue attempt",
                      systemImage: model.openAttempt(for: task) == nil ? "play.fill" : "arrow.right")
            }
            .buttonStyle(PlayheadButtonStyle())
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(Theme.panel000)
            .overlay(alignment: .top) { Theme.line.frame(height: 1) }
            .accessibilityIdentifier("startTask")
        }
        .themedList()
        .navigationTitle(task.targetApp)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $openAttempt) { AttemptView(attemptID: $0) }
    }
}

struct RecordingHowTo: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepList(steps: [
                "Swipe down from the top-right corner to open Control Center.",
                "Tap the Screen Recording button (a circle inside a ring). Recording starts after a 3-second countdown.",
                "Close Control Center and do the task.",
                "Stop recording: tap the red indicator at the top of the screen, then Stop. The video is saved to Photos.",
                "Come back here and choose the recording.",
            ])
            Text("If Screen Recording is missing, add it in Settings → Control Center.")
                .font(.footnote).foregroundStyle(Theme.inkFaint)
        }
    }
}

/// Numbered steps, numbered like timecodes.
struct StepList: View {
    let steps: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(String(format: "%02d", index + 1))
                        .font(.system(.subheadline, design: .monospaced).weight(.medium))
                        .foregroundStyle(Theme.playhead)
                        .accessibilityLabel("Step \(index + 1)")
                    Text(step).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Time, app and reward as small mono tags.
struct TaskMetaRow: View {
    let task: PhoneTask
    var showApp = true

    var body: some View {
        HStack(spacing: 6) {
            MetaChip(text: "\(Int(task.estimatedMinutes.rounded())) min", systemImage: "clock")
            if showApp {
                MetaChip(text: task.targetApp, systemImage: "iphone")
            }
            if let reward = task.reward {
                MetaChip(text: "\(reward.amount.formatted()) \(reward.unit)", systemImage: "gift")
            }
        }
    }
}

struct MetaChip: View {
    let text: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage).imageScale(.small)
            Text(text)
        }
            .font(Theme.meta)
            .lineLimit(1)
            .foregroundStyle(Theme.inkMuted)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Theme.panel000, in: RoundedRectangle(cornerRadius: 3))
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Theme.line))
    }
}
