import AppKit
import ApplicationServices
import ScreenCaptureKit

// Only dispatch to the exact Mirroring window captured in the before frame.
@main
struct PhoneAction {
    @MainActor
    static func main() async {
        do {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            guard let body = try JSONSerialization.jsonObject(with: input) as? [String: Any],
                  let action = body["action"] as? [String: Any], let kind = action["type"] as? String,
                  let frame = body["frame"] as? [String: Any], let windowID = frame["window_id"] as? UInt32,
                  let bounds = frame["window_bounds"] as? [Double], bounds.count == 4 else {
                throw failure("Invalid action or frame metadata")
            }
            guard AXIsProcessTrusted() else { throw failure("Enable Accessibility for the launching terminal/app in System Settings") }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: {
                $0.windowID == windowID && $0.owningApplication?.bundleIdentifier == "com.apple.ScreenContinuity" && $0.title == "iPhone Mirroring"
            }), let pid = window.owningApplication?.processID,
                  let app = NSRunningApplication(processIdentifier: pid) else { throw failure("Captured Mirroring window is unavailable") }
            let rect = window.frame
            let current = [rect.origin.x, rect.origin.y, rect.width, rect.height]
            guard zip(current, bounds).allSatisfy({ abs($0 - $1) < 1 }) else { throw failure("Mirroring window moved or resized; capture again") }
            app.activate()
            try await Task.sleep(for: .milliseconds(250))
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw failure("Could not focus iPhone Mirroring") }
            func post(_ event: CGEvent?) throws {
                guard let event else { throw failure("Could not create input event") }
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw failure("Mirroring lost focus; action outcome may be partial") }
                event.postToPid(pid)
            }
            func key(_ code: CGKeyCode, flags: CGEventFlags = []) throws {
                for down in [true, false] {
                    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
                    event?.flags = flags
                    try post(event)
                }
            }
            switch kind {
            case "tap", "scroll":
                guard let x = action["x"] as? Double, let y = action["y"] as? Double,
                      x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { throw failure("Invalid coordinates") }
                let point = CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
                if kind == "tap" {
                    try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
                    try await Task.sleep(for: .milliseconds(60))
                    try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
                } else {
                    guard let dy = action["dy"] as? Double, dy.isFinite, abs(dy) <= 1000 else { throw failure("Invalid scroll distance") }
                    try post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
                    let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(dy), wheel2: 0, wheel3: 0)
                    event?.location = point
                    try post(event)
                }
            case "type":
                guard let value = action["text"] as? String, !value.isEmpty, value.count <= 500 else { throw failure("Invalid text") }
                // Small chunks stay within Quartz's per-event Unicode limits.
                for character in value {
                    let units = Array(String(character).utf16)
                    for down in [true, false] {
                        let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                        units.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
                        try post(event)
                    }
                }
            case "home": try key(4, flags: [.maskCommand]) // Mirroring: Command-H.
            default: throw failure("Unsupported action")
            }
            print("{\"status\":\"events_posted\",\"physical_outcome_verified\":false}")
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
    static func failure(_ message: String) -> NSError { NSError(domain: "PhoneAction", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
