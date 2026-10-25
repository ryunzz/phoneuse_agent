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
                        .foregroundStyle(Theme.inkFaint)
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
        .themedList()
    }
}

struct TaskRow: View {
    let task: PhoneTask

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(task.title)
                .font(Theme.display(24, relativeTo: .headline))
                .foregroundStyle(Theme.ink)
            Text(task.summary)
                .font(.subheadline)
                .foregroundStyle(Theme.inkMuted)
                .lineLimit(2)
            TaskMetaRow(task: task)
        }
        .padding(.vertical, 6)
    }
}

struct AttemptStatusText: View {
    let attempt: Attempt

    var body: some View {
        Group {
            switch attempt.phase {
            case .draft:
                if attempt.videoFile == nil {
                    Label("Waiting for your recording", systemImage: "video.badge.plus").foregroundStyle(Theme.inkFaint)
                } else {
                    Label("Ready to submit", systemImage: "arrow.up.circle").foregroundStyle(Theme.playhead)
                }
            case .uploading:
                Label("Uploading…", systemImage: "icloud.and.arrow.up").foregroundStyle(Theme.playhead)
            case .failed:
                Label("Upload didn't finish. Open to retry.", systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.rec)
            case .submitted:
                Label("Submitted", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.clipAudio)
            }
        }
        .font(.subheadline)
    }
}
