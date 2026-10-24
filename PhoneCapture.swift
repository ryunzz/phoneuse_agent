import Foundation
import ScreenCaptureKit
import AppKit

// Capture only the iPhone Mirroring window, never the entire Mac desktop.
@main
struct PhoneCapture {
    @MainActor
    static func main() async {
        _ = NSApplication.shared
        guard CommandLine.arguments.count == 2 else { return }
        let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        var count = 0
        var lastState = ""
        func status(_ state: String, _ message: String) {
            lastState = state
            let data: [String: Any] = ["state": state, "message": message, "frames": count]
            if let bytes = try? JSONSerialization.data(withJSONObject: data) {
                FileHandle.standardOutput.write(bytes + Data([10]))
            }
        }
        while !Task.isCancelled {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                guard let window = content.windows.filter({
                    $0.owningApplication?.bundleIdentifier == "com.apple.ScreenContinuity" &&
                    $0.title == "iPhone Mirroring" && $0.frame.width > 100 && $0.frame.height > 100
                }).max(by: { $0.frame.height < $1.frame.height }) else {
                    status("waiting_for_window", "Open and unlock iPhone Mirroring on this Mac.")
                    try await Task.sleep(for: .seconds(2))
                    continue
                }
                let config = SCStreamConfiguration()
                config.width = Int(window.frame.width * 2)
                config.height = Int(window.frame.height * 2)
                config.showsCursor = false
                config.captureResolution = .best
                let captureStarted = Date().timeIntervalSince1970
                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
                let bitmap = NSBitmapImageRep(cgImage: image)
                guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
                    throw NSError(domain: "PhoneCapture", code: 1)
                }
                try jpeg.write(to: folder.appendingPathComponent("latest.jpg"), options: .atomic)
                count += 1
                let filename = "frame-\(count).jpg"
                try jpeg.write(to: folder.appendingPathComponent(filename), options: .atomic)
                let metadata: [String: Any] = ["captured_at": Date().timeIntervalSince1970,
                    "frames": count, "width": image.width, "height": image.height,
                    "capture_started_at": captureStarted, "image": filename, "window_id": window.windowID,
                    "window_bounds": [window.frame.origin.x, window.frame.origin.y, window.frame.width, window.frame.height],
                    "source": "iPhone Mirroring window"]
                try JSONSerialization.data(withJSONObject: metadata).write(
                    to: folder.appendingPathComponent("latest.json"), options: .atomic)
                if count > 5 { try? FileManager.default.removeItem(at: folder.appendingPathComponent("frame-\(count - 5).jpg")) }
                if lastState != "capturing_window" { status("capturing_window", "Mirroring window captured; verify that the actual iPhone screen is visible.") }
                try await Task.sleep(for: .milliseconds(500))
            } catch {
                status("capture_error", error.localizedDescription)
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}
