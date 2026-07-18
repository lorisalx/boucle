import AVFoundation

/// Capture le micro (la voix de Loris → piste "Moi") via AVAudioEngine.
final class MicCapture {
    private let engine = AVAudioEngine()
    private var writer: AudioTrackWriter?

    /// Demande la permission micro (déclenche le prompt NSMicrophoneUsageDescription au 1er appel).
    static func requestPermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    /// Démarre la capture vers `url`. Throw si le moteur audio refuse de démarrer.
    func start(to url: URL) throws {
        let writer = AudioTrackWriter(url: url)
        self.writer = writer

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            writer.append(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    /// Stoppe la capture et ferme le fichier. Retourne true si de l'audio a été écrit.
    @discardableResult
    func stop() -> Bool {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        return writer?.finish() ?? false
    }
}
