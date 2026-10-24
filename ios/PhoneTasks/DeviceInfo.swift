import CryptoKit
import Foundation
import UIKit

struct DeviceInfo: Codable {
    let model: String
    let systemVersion: String
    let locale: String

    @MainActor
    static var current: DeviceInfo {
        DeviceInfo(model: modelIdentifier(), systemVersion: UIDevice.current.systemVersion, locale: Locale.current.identifier)
    }

    /// Hardware identifier such as "iPhone16,1"; the Simulator reports the device it simulates.
    private static func modelIdentifier() -> String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return "Simulator \(simulated)"
        }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { buffer in
            String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }
}

/// SHA-256 of a file, read in chunks so long recordings don't load into memory at once.
func sha256(of file: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty {
        hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}
