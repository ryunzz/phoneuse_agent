import Foundation
import Network

enum DiscoveryError: LocalizedError {
    case notFound
    case localNetworkDenied

    var errorDescription: String? {
        switch self {
        case .notFound:
            "Couldn't find the review Mac on this Wi-Fi. On the Mac, run `bun run phone` in the gateway folder, and check that the phone is on the same Wi-Fi. Some shared networks block this; use your phone's hotspot for the Mac instead."
        case .localNetworkDenied:
            "Phone Tasks isn't allowed to use the local network. Turn it on in Settings → Privacy & Security → Local Network → Phone Tasks."
        }
    }
}

/// Finds the gateway that `bun run phone` announces on the LAN (`_phonetasks._tcp`).
/// Its TXT record carries the Mac's current Wi-Fi IP and port.
enum Discovery {
    static let serviceType = "_phonetasks._tcp"

    @MainActor
    static func findGateway(timeout: TimeInterval = 8) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let browser = NWBrowser(for: .bonjourWithTXTRecord(type: serviceType, domain: nil), using: .tcp)
            // Every handler runs on the main queue, so this flag needs no lock.
            final class Once: @unchecked Sendable { var done = false }
            let once = Once()
            let finish: @Sendable (Result<URL, Error>) -> Void = { result in
                guard !once.done else { return }
                once.done = true
                browser.cancel()
                continuation.resume(with: result)
            }
            browser.browseResultsChangedHandler = { results, _ in
                for result in results {
                    guard case .bonjour(let txt) = result.metadata,
                          let ip = txt["ip"], let port = txt["port"],
                          let url = URL(string: "http://\(ip):\(port)")
                    else { continue }
                    finish(.success(url))
                    return
                }
            }
            browser.stateUpdateHandler = { state in
                switch state {
                case .waiting(let error), .failed(let error):
                    // kDNSServiceErr_PolicyDenied: the user hasn't allowed Local Network access.
                    if case .dns(let code) = error, code == -65570 {
                        finish(.failure(DiscoveryError.localNetworkDenied))
                    } else if case .failed = state {
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
}
