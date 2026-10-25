import Foundation
import Network

enum DiscoveryError: LocalizedError {
    case notFound
    case localNetworkDenied

    var errorDescription: String? {
        switch self {
        case .notFound:
            "Couldn't find the review Mac. On the Mac, run `bun run phone` in the gateway folder. Then either keep the phone on the same Wi-Fi, or plug it into the Mac with a cable (if the Wi-Fi blocks devices from seeing each other, also turn on Personal Hotspot)."
        case .localNetworkDenied:
            "Phone Tasks isn't allowed to use the local network. Turn it on in Settings → Privacy & Security → Local Network → Phone Tasks."
        }
    }
}

/// Finds the gateway that `bun run phone` announces (`_phonetasks._tcp`), over Wi-Fi or the USB cable.
/// Its TXT record lists every address the Mac has; the first one that answers `/health` wins.
enum Discovery {
    static let serviceType = "_phonetasks._tcp"

    @MainActor
    static func findGateway(timeout: TimeInterval = 15) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let browser = NWBrowser(for: .bonjourWithTXTRecord(type: serviceType, domain: nil), using: .tcp)
            // Every handler runs on the main queue, so this state needs no lock.
            final class State: @unchecked Sendable {
                var done = false
                var probed = Set<URL>()
            }
            let state = State()
            let finish: @Sendable (Result<URL, Error>) -> Void = { result in
                guard !state.done else { return }
                state.done = true
                browser.cancel()
                continuation.resume(with: result)
            }
            browser.browseResultsChangedHandler = { results, _ in
                for result in results {
                    guard case .bonjour(let txt) = result.metadata, let port = txt["port"] else { continue }
                    let ips = (txt["ips"] ?? txt["ip"] ?? "").split(separator: ",").map(String.init)
                    for ip in ips {
                        guard let url = URL(string: "http://\(ip):\(port)"), state.probed.insert(url).inserted else { continue }
                        Task {
                            if await answers(url) { await MainActor.run { finish(.success(url)) } }
                        }
                    }
                }
            }
            browser.stateUpdateHandler = { browserState in
                switch browserState {
                case .waiting(let error), .failed(let error):
                    // kDNSServiceErr_PolicyDenied: the user hasn't allowed Local Network access.
                    if case .dns(let code) = error, code == -65570 {
                        finish(.failure(DiscoveryError.localNetworkDenied))
                    } else if case .failed = browserState {
                        finish(.failure(DiscoveryError.notFound))
                    }
                default:
                    break
                }
            }
            browser.start(queue: .main)
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(.failure(DiscoveryError.notFound)) }
        }
    }

    private static func answers(_ base: URL) async -> Bool {
        var request = URLRequest(url: base.appendingPathComponent("health"))
        request.timeoutInterval = 3
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }
}
