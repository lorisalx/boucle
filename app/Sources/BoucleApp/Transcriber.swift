import Foundation

/// Un segment transcrit, horodaté en secondes depuis le début de la piste.
struct TranscriptSegment {
    let start: Double
    let end: Double
    let text: String
    /// "Moi" (micro de Loris) ou "Eux" (audio système).
    let speaker: String
}

/// Transcrit un WAV avec mlx_whisper (Whisper Apple MLX, rapide sur Apple Silicon).
/// Sortie JSON → segments horodatés. mlx_whisper s'appuie sur ffmpeg pour lire le WAV,
/// donc pas besoin de resampler à 16 kHz côté Swift.
enum Transcriber {
    /// Modèle par défaut, surchargables via $BOUCLE_WHISPER_MODEL.
    static var model: String {
        ProcessInfo.processInfo.environment["BOUCLE_WHISPER_MODEL"] ?? "mlx-community/whisper-large-v3-turbo"
    }

    /// Transcrit `wav`, en étiquetant chaque segment avec `speaker`. Retourne [] si la piste est muette/absente.
    static func transcribe(wav: URL, speaker: String) throws -> [TranscriptSegment] {
        guard FileManager.default.fileExists(atPath: wav.path) else { return [] }

        let outDir = wav.deletingLastPathComponent()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "mlx_whisper",
            "--model", model,
            "--output-format", "json",
            "--output-dir", outDir.path,
            "--output-name", wav.deletingPathExtension().lastPathComponent,
            wav.path,
        ]
        // ffmpeg + mlx_whisper vivent dans le Homebrew Apple Silicon.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        process.environment = env

        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "Boucle", code: 2, userInfo: [NSLocalizedDescriptionKey: "mlx_whisper a échoué (code \(process.terminationStatus)) sur \(wav.lastPathComponent)"])
        }

        let jsonURL = outDir.appendingPathComponent(wav.deletingPathExtension().lastPathComponent + ".json")
        let data = try Data(contentsOf: jsonURL)
        let decoded = try JSONDecoder().decode(WhisperJSON.self, from: data)
        return decoded.segments.map {
            TranscriptSegment(start: $0.start, end: $0.end, text: $0.text.trimmingCharacters(in: .whitespaces), speaker: speaker)
        }
        .filter { !$0.text.isEmpty }
    }

    private struct WhisperJSON: Decodable {
        let segments: [Segment]
        struct Segment: Decodable {
            let start: Double
            let end: Double
            let text: String
        }
    }
}
