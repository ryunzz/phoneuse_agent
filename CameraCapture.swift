import AVFoundation
import CoreImage
import Foundation

// Capture a camera pointed at a device (CP2) using the same folder contract as PhoneCapture:
// latest.jpg, numbered frame-N.jpg (last five kept), and latest.json naming the immutable frame.
// Usage: camera-capture --list | camera-capture <folder> [--device <uniqueID or name substring>]

func emit(_ object: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: object) {
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
}

func cameras() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(
        deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
        mediaType: .video, position: .unspecified
    ).devices
}

final class FrameWriter: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let folder: URL
    let device: AVCaptureDevice
    let context = CIContext()
    let interval: TimeInterval = 0.5
    var lastWrite: TimeInterval = 0
    var count = 0
    var announced = false

    init(folder: URL, device: AVCaptureDevice) {
        self.folder = folder
        self.device = device
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let started = Date().timeIntervalSince1970
        guard started - lastWrite >= interval, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastWrite = started
        let image = CIImage(cvPixelBuffer: pixels)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = context.jpegRepresentation(of: image, colorSpace: space,
                  options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.7])
        else {
            emit(["state": "capture_error", "message": "Could not encode camera frame", "frames": count])
            return
        }
        do {
            try jpeg.write(to: folder.appendingPathComponent("latest.jpg"), options: .atomic)
            count += 1
            let filename = "frame-\(count).jpg"
            try jpeg.write(to: folder.appendingPathComponent(filename), options: .atomic)
            let metadata: [String: Any] = [
                "captured_at": Date().timeIntervalSince1970, "frames": count,
                "width": Int(image.extent.width), "height": Int(image.extent.height),
                "capture_started_at": started, "image": filename, "source": "camera",
                "device_id": device.uniqueID, "device_name": device.localizedName,
            ]
            try JSONSerialization.data(withJSONObject: metadata).write(
                to: folder.appendingPathComponent("latest.json"), options: .atomic)
            if count > 5 { try? FileManager.default.removeItem(at: folder.appendingPathComponent("frame-\(count - 5).jpg")) }
            if !announced {
                announced = true
                emit(["state": "capturing_camera", "message": "Camera \(device.localizedName) captured; verify the device screen is in view.", "frames": count])
            }
        } catch {
            emit(["state": "capture_error", "message": error.localizedDescription, "frames": count])
        }
    }
}

@main
struct CameraCapture {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["--list"] {
            for device in cameras() {
                emit(["id": device.uniqueID, "name": device.localizedName, "model": device.modelID])
            }
            return
        }
        guard let path = args.first, !path.hasPrefix("--") else {
            emit(["state": "usage_error", "message": "Usage: camera-capture --list | camera-capture <folder> [--device <id or name>]"])
            exit(2)
        }
        var wanted: String?
        if let flag = args.firstIndex(of: "--device"), flag + 1 < args.count { wanted = args[flag + 1] }

        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .video) { ok in
            granted = ok
            semaphore.signal()
        }
        semaphore.wait()
        guard granted else {
            emit(["state": "permission_denied", "message": "Allow camera access for this terminal/app in System Settings > Privacy & Security > Camera."])
            exit(1)
        }

        let available = cameras()
        let device: AVCaptureDevice?
        if let wanted {
            device = available.first { $0.uniqueID == wanted || $0.localizedName.localizedCaseInsensitiveContains(wanted) }
        } else {
            device = AVCaptureDevice.default(for: .video) ?? available.first
        }
        guard let device else {
            emit(["state": "no_camera", "message": wanted.map { "No camera matches \($0); run --list" } ?? "No camera found"])
            exit(1)
        }

        let folder = URL(fileURLWithPath: path, isDirectory: true)
        let session = AVCaptureSession()
        session.sessionPreset = .high
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { throw NSError(domain: "CameraCapture", code: 1) }
            session.addInput(input)
        } catch {
            emit(["state": "capture_error", "message": "Cannot open \(device.localizedName): \(error.localizedDescription)"])
            exit(1)
        }
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        let writer = FrameWriter(folder: folder, device: device)
        output.setSampleBufferDelegate(writer, queue: DispatchQueue(label: "camera-frames"))
        guard session.canAddOutput(output) else {
            emit(["state": "capture_error", "message": "Cannot read frames from \(device.localizedName)"])
            exit(1)
        }
        session.addOutput(output)
        emit(["state": "starting", "message": "Opening camera \(device.localizedName)", "frames": 0])
        session.startRunning()
        signal(SIGTERM) { _ in exit(0) }
        withExtendedLifetime((session, writer)) { dispatchMain() }
    }
}
