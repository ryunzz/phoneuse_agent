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
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Label(attempt.task.targetApp, systemImage: "iphone").capStyle()
                    Text(attempt.task.title)
                        .font(Theme.display(30))
                        .foregroundStyle(Theme.ink)
                    AttemptProgress(
                        consented: attempt.consentedAt != nil,
                        hasVideo: attempt.videoFile != nil || attempt.phase == .submitted,
                        submitted: attempt.phase == .submitted
                    )
                }
                .padding(.vertical, 6)
                DisclosureGroup(isExpanded: $showTask) {
                    StepList(steps: attempt.task.steps)
                        .padding(.vertical, 4)
                    Label(attempt.task.evidence, systemImage: "eye")
                        .font(.callout)
                        .foregroundStyle(Theme.inkMuted)
                } label: {
                    Text("Task brief").foregroundStyle(Theme.ink)
                }
            }

            if attempt.phase == .submitted {
                Section {
                    Label {
                        Text("The Mac has your recording. Follow the review in My submissions.")
                            .foregroundStyle(Theme.inkMuted)
                    } icon: {
                        Image(systemName: "checkmark.seal.fill").foregroundStyle(Theme.clipAudio)
                    }
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
                StepHeader(number: 1, title: "Consent")
            } footer: {
                Text("Screen recordings capture everything on screen, including notifications and other apps. Only the review Mac on your Wi-Fi receives it. Payments are not enabled in this beta.")
            }

            Section {
                if let url = model.videoURL(for: attempt) {
                    VideoPlayer(player: player)
                        .frame(height: 380)
                        .background(Color.black)
                        .listRowInsets(EdgeInsets())
                        .onAppear { if player == nil { player = AVPlayer(url: url) } }
                        .onChange(of: url) { _, newURL in player = AVPlayer(url: newURL) }
                    if let seconds = attempt.durationSeconds {
                        LabeledContent("Length") {
                            Text(Duration.seconds(seconds).formatted(.time(pattern: .minuteSecond)))
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(Theme.playhead)
                        }
                    }
                    if !locked {
                        PhotosPicker(selection: $pickerItem, matching: .videos, photoLibrary: .shared()) {
                            Label("Replace recording", systemImage: "arrow.triangle.2.circlepath")
                        }
                        Button(role: .destructive) {
                            player = nil
                            model.removeVideo(attemptID)
                        } label: {
                            Label("Remove recording", systemImage: "trash")
                        }
                        .tint(Theme.rec)
                    }
                } else if attempt.phase != .submitted {
                    PhotosPicker(selection: $pickerItem, matching: .videos, photoLibrary: .shared()) {
                        VStack(spacing: 8) {
                            Image(systemName: "video.badge.plus")
                                .font(.system(size: 30))
                            Text("Choose screen recording").font(.headline)
                            Text("From your Photos library")
                                .font(Theme.meta)
                                .foregroundStyle(Theme.inkFaint)
                        }
                        .foregroundStyle(Theme.playhead)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 26)
                        .background(Theme.panel000, in: RoundedRectangle(cornerRadius: 4))
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .strokeBorder(Theme.playhead.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [6, 4]))
                        )
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 4)
                    .accessibilityIdentifier("chooseRecording")
                    DisclosureGroup("How to record") {
                        RecordingHowTo()
                            .padding(.vertical, 4)
                    }
                }
                if isImporting { ProgressView("Preparing video…") }
                if let importError {
                    Label(importError, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.rec)
                }
            } header: {
                StepHeader(number: 2, title: "Recording")
            } footer: {
                Text("Trim unrelated parts in Photos (Edit) before choosing the video.")
            }

            Section {
                ForEach(Outcome.allCases) { outcome in
                    let selected = attempt.outcome == outcome
                    Button {
                        model.update(attemptID) { $0.outcome = outcome }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: outcome.symbol)
                                .font(.title3)
                                .foregroundStyle(outcome.color)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(outcome.label).foregroundStyle(Theme.ink)
                                Text(outcome.detail).font(.footnote).foregroundStyle(Theme.inkFaint)
                            }
                            Spacer()
                            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                                .foregroundStyle(selected ? Theme.playhead : Theme.line)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(locked)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
                TextField("Note for the reviewer (optional)", text: Binding(
                    get: { attempt.note },
                    set: { value in model.update(attemptID) { $0.note = String(value.prefix(2000)) } }
                ), axis: .vertical)
                .lineLimit(2...6)
                .disabled(locked)
            } header: {
                StepHeader(number: 3, title: "How did it go?")
            }

            if attempt.phase != .submitted {
                Section {
                    Button(role: .destructive) { confirmAbandon = true } label: {
                        Label("Abandon this attempt", systemImage: "xmark.bin")
                    }
                    .tint(Theme.rec)
                    .disabled(attempt.phase == .uploading)
                }
            }
        }
        .themedList()
        .safeAreaInset(edge: .bottom) {
            submitBar(attempt)
                .padding(.horizontal)
                .padding(.vertical, 12)
                .background(Theme.panel000)
                .overlay(alignment: .top) { Theme.line.frame(height: 1) }
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
            case .submitted:
                Label("Submitted. Waiting for review.", systemImage: "checkmark.seal.fill")
                    .font(.headline)
                    .foregroundStyle(Theme.clipAudio)
                    .accessibilityIdentifier("submittedBanner")
                Button("Done") { dismiss() }
                    .buttonStyle(PlayheadButtonStyle())
            case .uploading:
                let progress = model.uploadProgress[attemptID] ?? 0
                HStack {
                    Text("Uploading to the review Mac").capStyle()
                    Spacer()
                    Text(progress, format: .percent.precision(.fractionLength(0)))
                        .font(.system(.subheadline, design: .monospaced))
                        .foregroundStyle(Theme.playhead)
                }
                ProgressView(value: progress)
                Text("Keep the app open until it finishes.").font(.footnote).foregroundStyle(Theme.inkFaint)
            case .failed:
                Label(attempt.lastError ?? "The upload failed.", systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(Theme.rec)
                    .lineLimit(4)
                submitButton(attempt, title: "Retry upload", systemImage: "arrow.clockwise")
            default:
                if attempt.consentedAt == nil {
                    Text("Agree to the consent first.").font(Theme.meta).foregroundStyle(Theme.inkFaint)
                } else if attempt.videoFile == nil {
                    Text("Choose your screen recording first.").font(Theme.meta).foregroundStyle(Theme.inkFaint)
                }
                submitButton(attempt, title: "Submit recording", systemImage: "arrow.up")
            }
        }
    }

    private func submitButton(_ attempt: Attempt, title: String, systemImage: String) -> some View {
        Button {
            player?.pause()
            Task { await model.submit(attemptID) }
        } label: {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(PlayheadButtonStyle())
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

/// Section header numbered like a timecode: "01  Consent".
struct StepHeader: View {
    let number: Int
    let title: String

    var body: some View {
        HStack(spacing: 8) {
            Text(String(format: "%02d", number))
                .font(.system(.caption, design: .monospaced).weight(.medium))
                .foregroundStyle(Theme.playhead)
            Text(title).capStyle()
        }
    }
}

/// Consent, recording and submit as three segments that fill in.
struct AttemptProgress: View {
    let consented: Bool
    let hasVideo: Bool
    let submitted: Bool

    var body: some View {
        HStack(spacing: 6) {
            segment("Consent", done: consented)
            segment("Recording", done: hasVideo)
            segment("Submitted", done: submitted)
        }
    }

    private func segment(_ title: String, done: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Rectangle()
                .fill(done ? Theme.playhead : Theme.line)
                .frame(height: 3)
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(done ? Theme.ink : Theme.inkFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityValue(done ? "Done" : "Not done")
    }
}
