import SwiftUI
import DreamDAWModels
import DreamDAWEngine

// MARK: - RenderDialogView

/// Render/export dialog opened via Cmd+Shift+R.
/// Shows render range, file name input, folder picker, and progress bar.
public struct RenderDialogView: View {

    @ObservedObject var project: Project
    @State private var fileName: String = "Untitled"
    @State private var outputFolder: URL? = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask).first
    @State private var isRendering: Bool = false
    @State private var progress: Double = 0.0
    @State private var errorMessage: String?
    @State private var renderComplete: Bool = false

    /// Dismiss callback.
    public var onDismiss: (() -> Void)?

    private let renderEngine = RenderEngine()

    public init(project: Project, onDismiss: (() -> Void)? = nil) {
        self.project = project
        self.onDismiss = onDismiss
    }

    // Computed render range
    private var renderEnd: TimePosition {
        RenderEngine.calculateRenderEnd(project: project)
    }

    private var renderDurationSeconds: Double {
        renderEnd.toSeconds(bpm: project.bpm)
    }

    public var body: some View {
        VStack(spacing: 16) {
            // Header
            HStack {
                Image(systemName: "waveform.badge.plus")
                    .font(.title2)
                    .foregroundColor(.accentColor)
                Text("Render to Audio")
                    .font(.title2.bold())
                Spacer()
            }

            Divider()

            // Render Range
            GroupBox("Render Range") {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Start:")
                                .foregroundColor(.secondary)
                            Text("0:00.000")
                                .font(.system(.body, design: .monospaced))
                        }
                        HStack {
                            Text("End:")
                                .foregroundColor(.secondary)
                            Text(formatTime(renderDurationSeconds))
                                .font(.system(.body, design: .monospaced))
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("Duration: \(formatTime(renderDurationSeconds))")
                            .foregroundColor(.secondary)
                        Text("Format: WAV 24-bit / 44.1 kHz")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                .padding(4)
            }

            // File name
            GroupBox("Output") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("File Name:")
                            .foregroundColor(.secondary)
                        TextField("Render Name", text: $fileName)
                            .textFieldStyle(.roundedBorder)
                        Text(".wav")
                            .foregroundColor(.secondary)
                    }

                    HStack {
                        Text("Folder:")
                            .foregroundColor(.secondary)
                        Text(outputFolder?.path ?? "Not selected")
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .foregroundColor(.primary)
                        Spacer()
                        Button("Browse…") {
                            chooseFolder()
                        }
                    }
                }
                .padding(4)
            }

            // Progress
            if isRendering {
                VStack(spacing: 4) {
                    ProgressView(value: progress, total: 1.0)
                        .progressViewStyle(.linear)
                    Text("Rendering… \(Int(progress * 100))%")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            if let error = errorMessage {
                Text(error)
                    .foregroundColor(.red)
                    .font(.caption)
            }

            if renderComplete {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                    Text("Render complete!")
                        .foregroundColor(.green)
                }
            }

            Divider()

            // Buttons
            HStack {
                Button("Cancel") {
                    onDismiss?()
                }
                .keyboardShortcut(.cancelAction)

                Spacer()

                Button(renderComplete ? "Done" : "Render") {
                    if renderComplete {
                        onDismiss?()
                    } else {
                        startRender()
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(isRendering || fileName.isEmpty || outputFolder == nil)
            }
        }
        .padding(20)
        .frame(width: 500, height: 420)
    }

    // MARK: - Actions

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose Folder"

        if panel.runModal() == .OK, let url = panel.url {
            outputFolder = url
        }
    }

    private func startRender() {
        guard let folder = outputFolder else { return }

        let sanitizedName = fileName.replacingOccurrences(of: "/", with: "_")
        let outputURL = folder.appendingPathComponent("\(sanitizedName).wav")

        isRendering = true
        errorMessage = nil
        progress = 0.0

        renderEngine.onProgress = { p in
            self.progress = p
        }

        renderEngine.onComplete = { result in
            self.isRendering = false
            switch result {
            case .success:
                self.renderComplete = true
            case .failure(let error):
                self.errorMessage = error.localizedDescription
            }
        }

        renderEngine.render(project: project, to: outputURL)
    }

    private func formatTime(_ seconds: Double) -> String {
        let mins = Int(seconds) / 60
        let secs = seconds - Double(mins * 60)
        return String(format: "%d:%06.3f", mins, secs)
    }
}
