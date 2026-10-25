import SwiftUI

@main
struct PhoneTasksApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Theme.applyAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(Theme.playhead)
                .task { await model.refresh() }
                .onChange(of: scenePhase) { _, phase in
                    // Coming back from recording in another app, or from the Mac's review.
                    if phase == .active { Task { await model.refresh() } }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.pairing == nil {
            NavigationStack { PairingView() }
        } else {
            TabView {
                NavigationStack { TaskListView() }
                    .tabItem { Label("Tasks", systemImage: "checklist") }
                NavigationStack { SubmissionsView() }
                    .tabItem { Label("My submissions", systemImage: "tray.full") }
                NavigationStack { SettingsView() }
                    .tabItem { Label("Settings", systemImage: "gear") }
            }
        }
    }
}

/// Shown at the top of lists when the Mac can't be reached.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let error = model.connectionError {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Not connected", systemImage: "wifi.exclamationmark")
                        .font(.headline)
                        .foregroundStyle(Theme.rec)
                    Text(error).font(.callout).foregroundStyle(Theme.inkMuted)
                    Button("Try again") { Task { await model.refresh() } }
                        .buttonStyle(.bordered)
                }
                .padding(.vertical, 4)
            }
        }
    }
}
