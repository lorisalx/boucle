import AVFoundation
import ScreenCaptureKit

/// Capture l'audio système (l'autre bout du Zoom/Meet → piste "Eux") via ScreenCaptureKit.
///
/// SCStream exige un filtre sur un display même pour de l'audio seul ; on garde une
/// résolution vidéo minuscule (les frames vidéo sont ignorées) et on ne consomme que
/// le flux `.audio`. La permission "Enregistrement de l'écran" est demandée par macOS
/// au premier appel de `SCShareableContent`.
final class SystemAudioCapture: NSObject, SCStreamOutput {
    private var stream: SCStream?
    private var writer: AudioTrackWriter?
    private let sampleQueue = DispatchQueue(label: "boucle.sysaudio")

    /// Démarre la capture vers `url`. Throw si la permission écran manque ou qu'aucun display n'est dispo.
    func start(to url: URL) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "Boucle", code: 1, userInfo: [NSLocalizedDescriptionKey: "Aucun écran disponible pour la capture audio système."])
        }

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true // ne pas capter le son de Boucle lui-même
        config.sampleRate = 48_000
        config.channelCount = 2
        // Vidéo réduite au strict minimum (obligatoire mais inutilisée).
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let writer = AudioTrackWriter(url: url)
        self.writer = writer

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    /// Stoppe la capture et ferme le fichier. Retourne true si de l'audio a été écrit.
    func stop() async -> Bool {
        if let stream { try? await stream.stopCapture() }
        stream = nil
        return writer?.finish() ?? false
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let pcm = sampleBuffer.toPCMBuffer() else { return }
        writer?.append(pcm)
    }
}

private extension CMSampleBuffer {
    /// Convertit un CMSampleBuffer audio en AVAudioPCMBuffer (copie des échantillons).
    func toPCMBuffer() -> AVAudioPCMBuffer? {
        guard let formatDesc = CMSampleBufferGetFormatDescription(self),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else { return nil }
        var asbdVar = asbd
        guard let format = AVAudioFormat(streamDescription: &asbdVar) else { return nil }

        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(self))
        guard frameCount > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return nil }
        pcm.frameLength = frameCount

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            self, at: 0, frameCount: Int32(frameCount), into: pcm.mutableAudioBufferList
        )
        return status == noErr ? pcm : nil
    }
}
