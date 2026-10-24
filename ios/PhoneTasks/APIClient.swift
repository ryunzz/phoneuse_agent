import Foundation

enum APIError: LocalizedError {
    case unreachable(String)
    case server(Int, String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .unreachable(let detail):
            "Can't reach the review Mac. Check that the phone is on the same Wi-Fi and the gateway is running with HOST=0.0.0.0. (\(detail))"
        case .server(401, _):
            "The Mac didn't accept this phone's key. Pair again in Settings."
        case .server(_, let message):
            message
        case .invalidResponse:
            "The Mac sent a response the app didn't understand."
        }
    }
}

/// Talks to the contributor routes on the gateway (`/c/v1/*`).
struct APIClient {
    let pairing: Pairing

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30 * 60
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private func request(_ path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: pairing.baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(pairing.key)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest, body: Data? = nil, as type: T.Type) async throws -> T {
        var request = request
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await APIClient.session.data(for: request)
        } catch {
            throw APIError.unreachable(error.localizedDescription)
        }
        return try decode(data, response, as: type)
    }

    private func decode<T: Decodable>(_ data: Data, _ response: URLResponse, as type: T.Type) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Request failed (\(http.statusCode))"
            throw APIError.server(http.statusCode, message)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.invalidResponse
        }
    }

    func tasks() async throws -> [PhoneTask] {
        struct Body: Decodable { let tasks: [PhoneTask] }
        return try await perform(request("c/v1/tasks"), as: Body.self).tasks
    }

    func submissions() async throws -> [ServerSubmission] {
        struct Body: Decodable { let submissions: [ServerSubmission] }
        return try await perform(request("c/v1/submissions"), as: Body.self).submissions
    }

    func createSubmission(for attempt: Attempt, device: DeviceInfo) async throws -> ServerSubmission {
        struct Body: Encodable {
            let attemptId: String
            let taskId: String
            let taskVersion: Int
            let consentVersion: String
            let consentedAt: String
            let outcome: String
            let note: String
            let durationSeconds: Double
            let device: DeviceInfo
        }
        let body = Body(
            attemptId: attempt.id.uuidString.lowercased(),
            taskId: attempt.task.id,
            taskVersion: attempt.task.version,
            consentVersion: consentVersion,
            consentedAt: ISO8601DateFormatter().string(from: attempt.consentedAt ?? Date()),
            outcome: attempt.outcome.rawValue,
            note: attempt.note,
            durationSeconds: attempt.durationSeconds ?? 0,
            device: device
        )
        return try await perform(request("c/v1/submissions", method: "POST"), body: try JSONEncoder().encode(body), as: ServerSubmission.self)
    }

    func uploadMedia(submissionId: String, file: URL, contentType: String, progress: @escaping @Sendable (Double) -> Void) async throws -> ServerSubmission {
        var request = request("c/v1/submissions/\(submissionId)/media", method: "PUT")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30 * 60
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await APIClient.session.upload(for: request, fromFile: file, delegate: UploadProgress(progress))
        } catch {
            throw APIError.unreachable(error.localizedDescription)
        }
        return try decode(data, response, as: ServerSubmission.self)
    }

    func complete(submissionId: String, sha256: String) async throws -> ServerSubmission {
        let body = try JSONEncoder().encode(["sha256": sha256])
        return try await perform(request("c/v1/submissions/\(submissionId)/complete", method: "POST"), body: body, as: ServerSubmission.self)
    }
}

private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let onProgress: @Sendable (Double) -> Void

    init(_ onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}
