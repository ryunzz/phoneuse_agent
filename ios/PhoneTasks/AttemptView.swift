import AVKit
import CoreTransferable
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A video picked from Photos, copied into a temporary file the app owns.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

struct AttemptView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let attemptID: UUID

    @State private var pickerItem: PhotosPickerItem?
    @State private var isImporting = false
    @State private var importError: String?
    @State private var player: AVPlayer?
    @State private var confirmAbandon = false
    @State private var showTask = false

    var body: some View {
        if let attempt = model.attempt(attemptID) {
            content(attempt)
        } else {
            ContentUnavailableView("Attempt removed", systemImage: "trash")
        }
    }

    private func content(_ attempt: Attempt) -> some View {
        let locked = attempt.submissionId != nil
        return Form {
            if attempt.phase == .submitted {
                Section {
                    Label("Submitted. The Mac has your recording and it is waiting for review.", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                        .font(.headline)
                    Text("You can follow the review in My submissions.")
                    Button("Done") { dismiss() }
                }
            }

            Section {
                DisclosureGroup("Task: \(attempt.task.title)", isExpanded: $showTask) {
                    ForEach(Array(attempt.task.steps.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)")
                    }
                    Text("Show: \(attempt.task.evidence)").foregroundStyle(.secondary)
                }
            }

            Section {
                Toggle(isOn: Binding(
                    get: { attempt.consentedAt != nil },
                    set: { agreed in model.update(attemptID) { $0.consentedAt = agreed ? Date() : nil } }
                )) {
                    Text("I agree to upload this recording for review and for training AI models.")
                }
                .disabled(locked)
                .accessibilityIdentifier("consentToggle")
            } header: {
                Text("1. Consent")
            } footer: {
                Text("Screen recordings capture everything on screen, including notifications and other apps. Only the review Mac on your Wi-Fi receives it. Payments are not enabled in this beta.")
            }

            Section {
                if let url = model.videoURL(for: attempt) {
                    VideoPlayer(player: player)
                        .frame(height: 360)
                        .listRowInsets(EdgeInsets())
                        .onAppear { if player == nil { player = AVPlayer(url: url) } }
                        .onChange(of: url) { _, newURL in player = AVPlayer(url: newURL) }
                    if let seconds = attempt.durationSeconds {
                        Text("Length: \(Duration.seconds(seconds).formatted(.time(pattern: .minuteSecond)))")
                            .foregroundStyle(.secondary)
                    }
                    if !locked {
                        PhotosPicker("Replace recording", selection: $pickerItem, matching: .videos, photoLibrary: .shared())
                        Button("Remove recording", role: .destructive) {
                            player = nil
                            model.removeVideo(attemptID)
                        }
                    }
                } else if attempt.phase != .submitted {
                    PhotosPicker(selection: $pickerItem, matching: .videos, photoLibrary: .shared()) {
                        Label("Choose screen recording", systemImage: "video.badge.plus")
                            .font(.headline)
                    }
                    .accessibilityIdentifier("chooseRecording")
                    RecordingHowTo()
                }
                if isImporting { ProgressView("Preparing video…") }
                if let importError { Text(importError).foregroundStyle(.red) }
            } header: {
                Text("2. Recording")
            } footer: {
                Text("Trim unrelated parts in Photos (Edit) before choosing the video.")
            }

            Section("3. How did it go?") {
                Picker("Result", selection: Binding(
                    get: { attempt.outcome },
                    set: { value in model.update(attemptID) { $0.outcome = value } }
                )) {
                    ForEach(Outcome.allCases) { outcome in
                        Text(outcome.label).tag(outcome)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .disabled(locked)
                Text(attempt.outcome.detail).font(.footnote).foregroundStyle(.secondary)
                TextField("Note for the reviewer (optional)", text: Binding(
                    get: { attempt.note },
                    set: { value in model.update(attemptID) { $0.note = String(value.prefix(2000)) } }
                ), axis: .vertical)
                .lineLimit(2...6)
                .disabled(locked)
            }

            if attempt.phase != .submitted {
                Section {
                    Button("Abandon this attempt", role: .destructive) { confirmAbandon = true }
                        .disabled(attempt.phase == .uploading)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if attempt.phase != .submitted {
                submitBar(attempt)
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                    .background(.bar)
            }
        }
        .navigationTitle("Your attempt")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            Task { await importVideo(item) }
        }
        .confirmationDialog("Abandon this attempt?", isPresented: $confirmAbandon, titleVisibility: .visible) {
            Button("Abandon", role: .destructive) {
                model.abandon(attemptID)
                dismiss()
            }
        } message: {
            Text("The copy of the recording inside this app is deleted. The original stays in Photos.")
        }
    }

    /// Pinned under the form so the main action never needs scrolling.
    @ViewBuilder
    private func submitBar(_ attempt: Attempt) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            switch attempt.phase {
            case .uploading:
                Text("Uploading to the review Mac…")
                ProgressView(value: model.uploadProgress[attemptID] ?? 0)
                Text("Keep the app open until it finishes.").font(.footnote).foregroundStyle(.secondary)
            case .failed:
                Label(attempt.lastError ?? "The upload failed.", systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .lineLimit(4)
                submitButton(attempt, title: "Retry upload")
            default:
                if attempt.consentedAt == nil {
                    Text("Agree to the consent first.").font(.footnote).foregroundStyle(.secondary)
                } else if attempt.videoFile == nil {
                    Text("Choose your screen recording first.").font(.footnote).foregroundStyle(.secondary)
                }
                submitButton(attempt, title: "Submit recording")
            }
        }
    }

    private func submitButton(_ attempt: Attempt, title: String) -> some View {
        Button {
            player?.pause()
            Task { await model.submit(attemptID) }
        } label: {
            Text(title).font(.headline).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(attempt.consentedAt == nil || attempt.videoFile == nil || model.pairing == nil)
        .accessibilityIdentifier("submitButton")
    }

    private func importVideo(_ item: PhotosPickerItem) async {
        isImporting = true
        importError = nil
        defer {
            isImporting = false
            pickerItem = nil
        }
        do {
            guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
                importError = "That item isn't a video."
                return
            }
            player = nil
            try await model.attachVideo(attemptID, from: movie.url)
            if let attempt = model.attempt(attemptID), let url = model.videoURL(for: attempt) {
                player = AVPlayer(url: url)
            }
        } catch {
            importError = "Couldn't load the video: \(error.localizedDescription)"
        }
    }
}
