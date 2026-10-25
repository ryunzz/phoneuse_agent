import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmUnpair = false

    var body: some View {
        Form {
            Section("Review Mac") {
                LabeledContent("Address", value: model.pairing?.baseURL.absoluteString ?? "Not paired")
                if model.isRefreshing {
                    HStack { Text("Checking connection…"); Spacer(); ProgressView() }
                } else if let error = model.connectionError {
                    Label(error, systemImage: "wifi.exclamationmark").foregroundStyle(Theme.rec)
                } else {
                    Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.clipAudio)
                }
                Button("Check connection") { Task { await model.refresh() } }
            }
            Section {
                Button("Pair with a different Mac", role: .destructive) { confirmUnpair = true }
            } footer: {
                Text("Unpairing keeps attempts that haven't been sent yet on this phone.")
            }
            Section("About this beta") {
                Text("Recordings are demonstrations reviewed by a person. The app doesn't record your taps or typing.")
                Text("Payments are not enabled in this beta.")
            }
        }
        .navigationTitle("Settings")
        .themedList()
        .confirmationDialog("Unpair this phone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { model.unpair() }
        }
    }
}
