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
                        }
                    }
                }
            }
            Section {
                if model.submissions.isEmpty {
                    Text(model.isRefreshing ? "Loading…" : "Nothing submitted yet.").foregroundStyle(.secondary)
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
    }
}

struct SubmissionRow: View {
    let submission: ServerSubmission

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(submission.taskTitle).font(.headline)
                Spacer()
                ReviewBadge(state: submission.state)
            }
            Text("You reported: \(submission.outcome.label)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let completed = submission.completedAt.flatMap(parseDate) {
                Text("Sent \(completed.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let review = submission.latestReview, !review.reason.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reviewer feedback").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(review.reason)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(.vertical, 4)
    }

    private func parseDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

struct ReviewBadge: View {
    let state: String

    var body: some View {
        let (text, color): (String, Color) = switch state {
        case "approved": ("Approved", .green)
        case "rejected": ("Rejected", .red)
        case "pending_review": ("Pending review", .orange)
        default: ("Not finished", .gray)
        }
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(color)
            .overlay(Capsule().stroke(color))
    }
}
