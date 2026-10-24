import SwiftUI
import UIKit

/// First run: paste the pairing string printed by `bun run admin create-contributor`.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var error: String?
    @State private var isChecking = false

    var body: some View {
        Form {
            Section {
                Text("Connect this phone to the review Mac.")
                    .font(.title3.weight(.semibold))
                Text("On the Mac, run `bun run admin create-contributor <your name>` in the gateway folder and paste the line that starts with http:// here. The phone and the Mac must be on the same Wi-Fi.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section("Pairing string") {
                TextField("http://192.168.1.20:8787#ct_…", text: $text, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.body.monospaced())
                    .accessibilityIdentifier("pairingField")
                Button("Paste from clipboard") {
                    if let pasted = UIPasteboard.general.string { text = pasted }
                }
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
                        Text("Connect")
                        if isChecking { Spacer(); ProgressView() }
                    }
                }
                .disabled(isChecking || text.isEmpty)
                .accessibilityIdentifier("connectButton")
            }
        }
        .navigationTitle("Phone Tasks")
    }

    private func connect() async {
        guard let pairing = Pairing.parse(text) else {
            error = "That doesn't look like a pairing string. It should look like http://<mac-ip>:8787#ct_…"
            return
        }
        isChecking = true
        error = await model.pair(with: pairing)
        isChecking = false
    }
}
