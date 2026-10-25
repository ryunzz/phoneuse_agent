import SwiftUI

struct SubmissionsView: View {
    @Environment(AppModel.self) private var model

    private var unsent: [Attempt] {
        model.openAttempts.filter { $0.phase == .failed || $0.phase == .uploading }
    }

    var body: some View {
        List {
            ConnectionBanner()
            if !unsent.isEmpty {
                Section("Not submitted yet") {
                    ForEach(unsent) { attempt in
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
            Section {
                if model.submissions.isEmpty {
                    if model.isRefreshing {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Loading…").foregroundStyle(.secondary)
                        }
                    } else {
                        ContentUnavailableView(
                            "Nothing submitted yet",
                            systemImage: "tray",
                            description: Text("Finish a task and submit your screen recording. Reviews show up here.")
                        )
                    }
                }
                ForEach(model.submissions.filter(\.isComplete)) { submission in
                    SubmissionRow(submission: submission)
                }
            } header: {
                Text("Submitted")
            } footer: {
                Text("Payments are not enabled in this beta.")
            }
        }
        .navigationTitle("My submissions")
        .navigationDestination(for: UUID.self) { AttemptView(attemptID: $0) }
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .themedList()
    }
}

struct SubmissionRow: View {
    let submission: ServerSubmission

    var body: some View {
        let review = ReviewState(submission.state)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(submission.taskTitle)
                    .font(Theme.display(24, relativeTo: .headline))
                    .foregroundStyle(Theme.ink)
                Spacer()
                ReviewBadge(state: submission.state)
            }
            HStack(spacing: 12) {
                Label {
                    Text(submission.outcome.label)
                } icon: {
                    Image(systemName: submission.outcome.symbol).foregroundStyle(submission.outcome.color)
                }
                if let completed = submission.completedAt.flatMap(parseDate) {
                    Label(completed.formatted(date: .abbreviated, time: .shortened), systemImage: "paperplane")
                }
            }
            .font(Theme.meta)
            .foregroundStyle(Theme.inkFaint)
            if let latest = submission.latestReview, !latest.reason.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Reviewer feedback").capStyle()
                    Text(latest.reason)
                        .font(.callout)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.panel000, in: RoundedRectangle(cornerRadius: 4))
                .overlay(alignment: .leading) { review.color.frame(width: 2) }
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.line))
            }
        }
        .padding(.vertical, 6)
    }

    private func parseDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

/// How a server review state is shown.
struct ReviewState {
    let text: String
    let color: Color
    let symbol: String

    init(_ state: String) {
        (text, color, symbol) = switch state {
        case "approved": ("Approved", Theme.clipAudio, "checkmark")
        case "rejected": ("Rejected", Theme.rec, "xmark")
        case "pending_review": ("Pending", Theme.gold, "hourglass")
        default: ("Not finished", Theme.inkFaint, "ellipsis")
        }
    }
}

struct ReviewBadge: View {
    let state: String

    var body: some View {
        let review = ReviewState(state)
        Pill(text: review.text, color: review.color, systemImage: review.symbol)
    }
}
