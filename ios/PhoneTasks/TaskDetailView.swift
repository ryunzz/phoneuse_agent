import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let task: PhoneTask
    @State private var openAttempt: UUID?

    var body: some View {
        List {
            Section {
                Text(task.title).font(.title2.weight(.semibold))
                Text(task.summary)
                HStack(spacing: 12) {
                    Label("About \(Int(task.estimatedMinutes.rounded())) min", systemImage: "clock")
                    Label(task.targetApp, systemImage: "iphone")
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            Section("Before you start") {
                Text(task.startingConditions)
            }
            Section("Steps") {
                ForEach(Array(task.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(index + 1).").font(.body.monospacedDigit()).foregroundStyle(.secondary)
                        Text(step)
                    }
                }
            }
            Section("The recording must show") {
                Text(task.evidence)
                if !task.notes.isEmpty {
                    Text(task.notes).font(.callout).foregroundStyle(.secondary)
                }
            }
            Section("How to record") {
                RecordingHowTo()
            }
            Section {
                Label("Use test content only. Don't show messages, contacts, photos, or account details you wouldn't want reviewed.", systemImage: "hand.raised")
                    .font(.callout)
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button {
                openAttempt = model.startAttempt(for: task).id
            } label: {
                Text(model.openAttempt(for: task) == nil ? "Start task" : "Continue attempt")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal)
            .padding(.bottom, 8)
            .accessibilityIdentifier("startTask")
        }
        .navigationTitle(task.targetApp)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $openAttempt) { AttemptView(attemptID: $0) }
    }
}

struct RecordingHowTo: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            step(1, "Swipe down from the top-right corner to open Control Center.")
            step(2, "Tap the Screen Recording button (a circle inside a ring). Recording starts after a 3-second countdown.")
            step(3, "Close Control Center and do the task.")
            step(4, "Stop recording: tap the red indicator at the top of the screen, then Stop. The video is saved to Photos.")
            step(5, "Come back here and choose the recording.")
            Text("If Screen Recording is missing, add it in Settings → Control Center.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number).").font(.body.monospacedDigit()).foregroundStyle(.secondary)
            Text(text)
        }
    }
}
