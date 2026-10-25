import Foundation

/// Must match CONSENT_VERSION in gateway/src/submissions.ts.
let consentVersion = "2026-10-24"

struct Reward: Codable, Hashable {
    let amount: Double
    let unit: String
}

struct PhoneTask: Codable, Identifiable, Hashable {
    let id: String
    let version: Int
    let title: String
    let summary: String
    let targetApp: String
    let estimatedMinutes: Double
    let startingConditions: String
    let steps: [String]
    let evidence: String
    let notes: String
    let reward: Reward?
}

enum Outcome: String, Codable, CaseIterable, Identifiable {
    case succeeded, failed, blocked

    var id: String { rawValue }

    var label: String {
        switch self {
        case .succeeded: "It worked"
        case .failed: "It didn't work"
        case .blocked: "Couldn't do it"
        }
    }

    var detail: String {
        switch self {
        case .succeeded: "I finished the task."
        case .failed: "I tried, but the result is wrong."
        case .blocked: "An option was missing or the app was different."
        }
    }
}

struct ServerReview: Codable, Hashable {
    let decision: String
    let reason: String
    let at: String
}

struct ServerMedia: Codable, Hashable {
    let sha256: String
    let bytes: Int
}

struct ServerSubmission: Codable, Identifiable, Hashable {
    let id: String
    let attemptId: String
    let taskId: String
    let taskVersion: Int
    let taskTitle: String
    let outcome: Outcome
    let note: String
    let durationSeconds: Double
    let state: String
    let createdAt: String
    let completedAt: String?
    let media: ServerMedia?
    let reviews: [ServerReview]

    var latestReview: ServerReview? { reviews.last }

    var isComplete: Bool { ["pending_review", "approved", "rejected"].contains(state) }
}

/// A task attempt kept on the phone until the Mac confirms it has the recording.
struct Attempt: Codable, Identifiable, Hashable {
    enum Phase: String, Codable {
        case draft, uploading, failed, submitted
    }

    let id: UUID
    let task: PhoneTask
    let startedAt: Date
    var consentedAt: Date?
    var videoFile: String?
    var videoContentType: String?
    var durationSeconds: Double?
    var outcome: Outcome = .succeeded
    var note: String = ""
    var submissionId: String?
    var sha256: String?
    var phase: Phase = .draft
    var lastError: String?

    var isOpen: Bool { phase != .submitted }
}
