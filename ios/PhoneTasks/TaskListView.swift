import SwiftUI

struct TaskListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            ConnectionBanner()
            if !model.openAttempts.isEmpty {
                Section("In progress") {
                    ForEach(model.openAttempts) { attempt in
                        NavigationLink(value: attempt.id) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(attempt.task.title).font(.headline)
                                AttemptStatusText(attempt: attempt)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
            Section("Available tasks") {
                if model.tasks.isEmpty && model.connectionError == nil {
                    Text(model.isRefreshing ? "Loading tasks…" : "No tasks yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.tasks) { task in
                    NavigationLink(value: task) {
                        TaskRow(task: task)
                    }
                }
            }
        }
        .navigationTitle("Tasks")
        .navigationDestination(for: PhoneTask.self) { TaskDetailView(task: $0) }
        .navigationDestination(for: UUID.self) { AttemptView(attemptID: $0) }
        .refreshable { await model.refresh() }
    }
}

struct TaskRow: View {
    let task: PhoneTask

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(task.title).font(.headline)
            Text(task.summary).font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Label("About \(Int(task.estimatedMinutes.rounded())) min", systemImage: "clock")
                Label(task.targetApp, systemImage: "iphone")
                if let reward = task.reward {
                    Label("\(reward.amount.formatted()) \(reward.unit)", systemImage: "gift")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

struct AttemptStatusText: View {
    let attempt: Attempt

    var body: some View {
        switch attempt.phase {
        case .draft:
            Text(attempt.videoFile == nil ? "Waiting for your recording" : "Ready to submit")
                .font(.subheadline).foregroundStyle(.secondary)
        case .uploading:
            Text("Uploading…").font(.subheadline).foregroundStyle(.blue)
        case .failed:
            Text("Upload didn't finish. Open to retry.").font(.subheadline).foregroundStyle(.red)
        case .submitted:
            Text("Submitted").font(.subheadline).foregroundStyle(.green)
        }
    }
}
