import AVFoundation

/// Écrit un flux de buffers PCM dans un fichier WAV, en créant le fichier
/// paresseusement au format du premier buffer reçu. Thread-safe via une file série.
final class AudioTrackWriter {
    let url: URL
    private let queue = DispatchQueue(label: "boucle.audiowriter")
    private var file: AVAudioFile?
    private(set) var frames: Int64 = 0

    init(url: URL) {
        self.url = url
    }

    /// Ajoute un buffer (appelable depuis n'importe quel thread de capture).
    func append(_ buffer: AVAudioPCMBuffer) {
        queue.async {
            do {
                if self.file == nil {
                    // Le WAV hérite du format natif du buffer (Float32) — mlx_whisper/ffmpeg le relit sans souci.
                    self.file = try AVAudioFile(
                        forWriting: self.url,
                        settings: buffer.format.settings,
                        commonFormat: buffer.format.commonFormat,
                        interleaved: buffer.format.isInterleaved
                    )
                }
                try self.file?.write(from: buffer)
                self.frames += Int64(buffer.frameLength)
            } catch {
                NSLog("[Boucle] écriture audio échouée (%@): %@", self.url.lastPathComponent, error.localizedDescription)
            }
        }
    }

    /// Ferme le fichier et attend que tout soit flushé. Retourne true si des frames ont été écrites.
    func finish() -> Bool {
        queue.sync {
            self.file = nil // AVAudioFile flushe et ferme à la libération.
        }
        return frames > 0
    }
}
