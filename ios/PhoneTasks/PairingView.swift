import SwiftUI
import UIKit

/// First run: find the review Mac on the Wi-Fi and sign up, with a pairing string as a fallback.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("contributorName") private var name = ""
    @State private var text = ""
    @State private var error: String?
    @State private var isConnecting = false
    @State private var showManual = false

    var body: some View {
        Form {
            Section {
                Text("Connect this phone to the review Mac.")
                    .font(.title3.weight(.semibold))
                Text("On the Mac, run `bun run phone` in the gateway folder. Keep the phone on the same Wi-Fi, then tap Connect. Allow Local Network access if iOS asks.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section("Your name") {
                TextField("Shown to the reviewer", text: $name)
                    .textContentType(.name)
                    .accessibilityIdentifier("nameField")
            }
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }
            }
            Section {
                Button {
                    Task { await connect() }
                } label: {
                    HStack {
                        Text(isConnecting ? "Looking for the Mac…" : "Connect").font(.headline)
                        if isConnecting { Spacer(); ProgressView() }
                    }
                }
                .disabled(isConnecting || name.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("connectButton")
            }
            Section {
                DisclosureGroup("Use a pairing string instead", isExpanded: $showManual) {
                    Text("From `bun run admin create-contributor <name>`, for networks where the Mac can't be found automatically.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    TextField("http://192.168.1.20:8787#ct_…", text: $text, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .font(.body.monospaced())
                    Button("Paste from clipboard") {
                        if let pasted = UIPasteboard.general.string { text = pasted }
                    }
                    Button("Connect with pairing string") {
                        Task { await connectManually() }
                    }
                    .disabled(isConnecting || text.isEmpty)
                }
            }
        }
        .navigationTitle("Phone Tasks")
    }

    private func connect() async {
        isConnecting = true
        error = await model.connectAutomatically(name: name.trimmingCharacters(in: .whitespaces))
        isConnecting = false
    }

    private func connectManually() async {
        guard let pairing = Pairing.parse(text) else {
            error = "That doesn't look like a pairing string. It should look like http://<mac-ip>:8787#ct_…"
            return
        }
        isConnecting = true
        error = await model.pair(with: pairing)
        isConnecting = false
    }
}
