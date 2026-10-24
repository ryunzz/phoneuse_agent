import AVFoundation
import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    private(set) var pairing: Pairing?
    private(set) var tasks: [PhoneTask] = []
    private(set) var submissions: [ServerSubmission] = []
    private(set) var attempts: [Attempt] = []
    private(set) var uploadProgress: [UUID: Double] = [:]
    var connectionError: String?
    var isRefreshing = false

    private let folder: URL
    private var attemptsFile: URL { folder.appendingPathComponent("attempts.json") }
    private var recordings: URL { folder.appendingPathComponent("Recordings", isDirectory: true) }

    init() {
        folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PhoneTasks", isDirectory: true)
        try? FileManager.default.createDirectory(at: recordings, withIntermediateDirectories: true)
        pairing = Pairing.load()
        #if DEBUG
        // Simulator testing: `SIMCTL_CHILD_PHONETASKS_PAIRING=<pairing string> xcrun simctl launch …`.
        if let text = ProcessInfo.processInfo.environment["PHONETASKS_PAIRING"], let debugPairing = Pairing.parse(text) {
            debugPairing.save()
            pairing = debugPairing
        }
        #endif
        if let data = try? Data(contentsOf: attemptsFile), let saved = try? JSONDecoder().decode([Attempt].self, from: data) {
            // An app quit mid-upload leaves "uploading"; show it as retryable.
            attempts = saved.map { attempt in
                var attempt = attempt
                if attempt.phase == .uploading {
                    attempt.phase = .failed
                    attempt.lastError = "The upload was interrupted. Tap Retry."
                }
                return attempt
            }
        }
    }

    var client: APIClient? { pairing.map(APIClient.init) }

    var openAttempts: [Attempt] { attempts.filter(\.isOpen) }

    func openAttempt(for task: PhoneTask) -> Attempt? {
        attempts.first { $0.task.id == task.id && $0.isOpen }
    }

    func attempt(_ id: UUID) -> Attempt? {
        attempts.first { $0.id == id }
    }

    func videoURL(for attempt: Attempt) -> URL? {
        attempt.videoFile.map { recordings.appendingPathComponent($0) }
    }

    // MARK: Pairing

    func pair(with pairing: Pairing) async -> String? {
        do {
            _ = try await APIClient(pairing: pairing).tasks()
        } catch {
            return error.localizedDescription
        }
        pairing.save()
        self.pairing = pairing
        await refresh()
        return nil
    }

    func unpair() {
        Pairing.clear()
        pairing = nil
        tasks = []
        submissions = []
    }

    // MARK: Server state

    func refresh() async {
        guard let client else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            async let tasks = client.tasks()
            async let submissions = client.submissions()
            self.tasks = try await tasks
            self.submissions = try await submissions
            connectionError = nil
        } catch {
            connectionError = error.localizedDescription
        }
    }

    // MARK: Attempts

    func startAttempt(for task: PhoneTask) -> Attempt {
        if let existing = openAttempt(for: task) { return existing }
        let attempt = Attempt(id: UUID(), task: task, startedAt: Date())
        attempts.append(attempt)
        persist()
        return attempt
    }

    func update(_ id: UUID, _ change: (inout Attempt) -> Void) {
        guard let index = attempts.firstIndex(where: { $0.id == id }) else { return }
        change(&attempts[index])
        persist()
    }

    func abandon(_ id: UUID) {
        if let attempt = attempt(id) { removeVideo(of: attempt) }
        attempts.removeAll { $0.id == id }
        persist()
    }

    /// Moves a picked recording into the app's storage, replacing any earlier pick.
    func attachVideo(_ id: UUID, from picked: URL) async throws {
        guard let attempt = attempt(id) else { return }
        let ext = picked.pathExtension.lowercased() == "mp4" ? "mp4" : "mov"
        let name = "\(id.uuidString)-\(Int(Date().timeIntervalSince1970)).\(ext)"
        let destination = recordings.appendingPathComponent(name)
        try FileManager.default.moveItem(at: picked, to: destination)
        let duration = try await AVURLAsset(url: destination).load(.duration).seconds
        removeVideo(of: attempt)
        update(id) {
            $0.videoFile = name
            $0.videoContentType = ext == "mp4" ? "video/mp4" : "video/quicktime"
            $0.durationSeconds = duration.isFinite ? duration : 0
            $0.sha256 = nil
            $0.phase = .draft
            $0.lastError = nil
        }
    }

    func removeVideo(_ id: UUID) {
        guard let attempt = attempt(id) else { return }
        removeVideo(of: attempt)
        update(id) {
            $0.videoFile = nil
            $0.videoContentType = nil
            $0.durationSeconds = nil
            $0.sha256 = nil
        }
    }

    private func removeVideo(of attempt: Attempt) {
        if let url = videoURL(for: attempt) { try? FileManager.default.removeItem(at: url) }
    }

    /// Create (idempotent on attempt ID) → upload → verify checksum. Safe to call again after any failure.
    func submit(_ id: UUID) async {
        guard let client, let attempt = attempt(id), let file = videoURL(for: attempt), let contentType = attempt.videoContentType else { return }
        update(id) {
            $0.phase = .uploading
            $0.lastError = nil
        }
        uploadProgress[id] = 0
        defer { uploadProgress[id] = nil }
        do {
            let digest: String
            if let existing = attempt.sha256 {
                digest = existing
            } else {
                digest = try await Task.detached { try sha256(of: file) }.value
                update(id) { $0.sha256 = digest }
            }
            var server = try await client.createSubmission(for: attempt, device: DeviceInfo.current)
            update(id) { $0.submissionId = server.id }
            if !server.isComplete && server.media?.sha256 != digest {
                server = try await client.uploadMedia(submissionId: server.id, file: file, contentType: contentType) { fraction in
                    Task { @MainActor in self.uploadProgress[id] = fraction }
                }
            }
            server = try await client.complete(submissionId: server.id, sha256: digest)
            removeVideo(of: attempt)
            update(id) {
                $0.phase = .submitted
                $0.videoFile = nil
            }
            await refresh()
        } catch {
            update(id) {
                $0.phase = .failed
                $0.lastError = error.localizedDescription
            }
        }
    }

    private func persist() {
        do {
            try JSONEncoder().encode(attempts).write(to: attemptsFile, options: [.atomic, .completeFileProtection])
        } catch {
            connectionError = "Couldn't save your attempts on this phone: \(error.localizedDescription)"
        }
    }
}
