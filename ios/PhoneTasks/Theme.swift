import SwiftUI
import UIKit

/// The gateway pages' look (gateway/src/theme.ts): dark editor panels, a cyan playhead accent,
/// Instrument Serif for display type and mono for metadata.
enum Theme {
    static let black = Color(hex: 0x070708)
    static let panel000 = Color(hex: 0x0F0F11)
    static let panel100 = Color(hex: 0x17171A)
    static let line = Color(hex: 0x34343B)
    static let ink = Color(hex: 0xECEBE8)
    static let inkMuted = Color(hex: 0xA3A19C)
    static let inkFaint = Color(hex: 0x8C8A85)
    static let playhead = Color(hex: 0x00E5FF)
    static let onPlayhead = Color(hex: 0x140806)
    static let rec = Color(hex: 0xFF4D4D)
    static let clipText = Color(hex: 0xC784D6)
    static let clipAudio = Color(hex: 0x58B787)
    static let gold = Color(hex: 0xE9C25C)

    static let displayFontName = "InstrumentSerif-Regular"

    static func display(_ size: CGFloat, relativeTo style: Font.TextStyle = .title) -> Font {
        .custom(displayFontName, size: size, relativeTo: style)
    }

    static let meta = Font.system(.caption, design: .monospaced)

    /// Navigation and tab bars, which SwiftUI can't style on iOS 17.
    static func applyAppearance() {
        if let font = UIFont(name: displayFontName, size: 38) {
            UINavigationBar.appearance().largeTitleTextAttributes = [.font: font, .foregroundColor: UIColor(ink)]
        }

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = UIColor(panel000)
        tab.shadowColor = UIColor(line)
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

extension View {
    /// Lists and forms on the editor-black background with panel rows.
    func themedList() -> some View {
        scrollContentBackground(.hidden)
            .background(Theme.black)
    }

    /// The uppercase, tracked caption used for panel headers on the web pages.
    func capStyle() -> some View {
        font(.caption.weight(.semibold))
            .tracking(0.9)
            .textCase(.uppercase)
            .foregroundStyle(Theme.inkFaint)
    }
}

/// Filled cyan action, like the playhead.
struct PlayheadButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(isEnabled ? Theme.onPlayhead : Theme.inkFaint)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isEnabled ? Theme.playhead : Theme.panel100)
            )
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(isEnabled ? .clear : Theme.line))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// The bordered uppercase pill from the review pages.
struct Pill: View {
    let text: String
    let color: Color
    var systemImage: String?

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage) }
            Text(text)
        }
        .font(.system(size: 10, weight: .semibold))
        .tracking(0.8)
        .textCase(.uppercase)
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .overlay(RoundedRectangle(cornerRadius: 3).stroke(color))
    }
}

extension Outcome {
    var symbol: String {
        switch self {
        case .succeeded: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .blocked: "nosign"
        }
    }

    var color: Color {
        switch self {
        case .succeeded: Theme.clipAudio
        case .failed, .blocked: Theme.clipText
        }
    }
}
