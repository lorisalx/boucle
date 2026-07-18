import Foundation

/// Assemble les deux pistes transcrites en une note markdown déposée dans
/// brain/meetings/ avec `processed: false` — le contrat que la loop Boucle ramasse.
enum MeetingNote {
    /// Le dossier meetings du gbrain (surchargable via $BOUCLE_BRAIN_DIR).
    static var meetingsDir: URL {
        let base = ProcessInfo.processInfo.environment["BOUCLE_BRAIN_DIR"]
            ?? NSHomeDirectory() + "/Documents/dataiku/brain"
        return URL(fileURLWithPath: base).appendingPathComponent("meetings")
    }

    /// Fusionne les segments des deux pistes par ordre chronologique et écrit le .md.
    /// `meeting` (issu du calendrier) fournit titre + participants quand il est dispo.
    /// Retourne l'URL du fichier écrit.
    @discardableResult
    static func write(
        mic: [TranscriptSegment],
        system: [TranscriptSegment],
        startedAt: Date,
        meeting: MeetingInfo?
    ) throws -> URL {
        let merged = (mic + system).sorted { $0.start < $1.start }

        // Le préfixe locuteur (« Moi » = micro / « Eux » = audio système) n'a de sens
        // que sur un enregistrement DEUX pistes (réunion à distance). Sur une seule
        // piste — réunion en présentiel, ou audio système absent faute de permission
        // écran — tout provient du micro : l'étiqueter « Moi » est trompeur (« Moi »
        // partout alors qu'il y a plusieurs personnes). Dans ce cas on omet le préfixe.
        let twoTrack = !mic.isEmpty && !system.isEmpty

        var body = ""
        for seg in merged {
            if twoTrack {
                body += "\(timecode(seg.start)) **\(seg.speaker):** \(seg.text)\n\n"
            } else {
                body += "\(timecode(seg.start)) \(seg.text)\n\n"
            }
        }
        if merged.isEmpty {
            body = "_(aucune parole détectée)_\n"
        }

        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        let dateStr = df.string(from: startedAt)
        df.dateFormat = "HH-mm"
        let timeStr = df.string(from: startedAt)

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]

        let title = meeting?.title ?? "Meeting — \(dateStr) \(timeStr.replacingOccurrences(of: "-", with: ":"))"

        // Front-matter : les participants bruts (nom/email du calendrier) sont laissés
        // à la loop sonnet-5 pour mapping vers les slugs [[people/…]] du gbrain.
        var frontLines = [
            "---",
            "date: \(iso.string(from: startedAt))",
            "title: \(yaml(title))",
            "source: boucle-recorder",
            "processed: false",
        ]
        if let attendees = meeting?.attendees, !attendees.isEmpty {
            frontLines.append("attendees_raw:")
            for a in attendees { frontLines.append("  - \(yaml(a))") }
        }
        if let notes = meeting?.notes, let link = firstMeetingLink(in: notes) {
            frontLines.append("call_link: \(link)")
        }
        frontLines.append("---")

        let note = "\(frontLines.joined(separator: "\n"))\n\n# \(title)\n\n\(body)"

        try FileManager.default.createDirectory(at: meetingsDir, withIntermediateDirectories: true)
        let url = meetingsDir.appendingPathComponent("\(dateStr)-\(slug(title, fallback: "meeting")).md")
        try note.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    // MARK: - Formatting helpers

    /// "[mm:ss]" ou "[h:mm:ss]" à partir de secondes.
    private static func timecode(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "[%d:%02d:%02d]", h, m, s) : String(format: "[%02d:%02d]", m, s)
    }

    /// Slug de nom de fichier : minuscules, sans accents, alphanumérique + tirets.
    private static func slug(_ s: String, fallback: String) -> String {
        let folded = s.folding(options: .diacriticInsensitive, locale: .current).lowercased()
        var out = ""
        for ch in folded {
            if ch.isLetter || ch.isNumber { out.append(ch) }
            else if !out.hasSuffix("-") { out.append("-") }
        }
        let trimmed = out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return trimmed.isEmpty ? fallback : String(trimmed.prefix(60))
    }

    /// Échappe une valeur YAML inline si nécessaire.
    private static func yaml(_ s: String) -> String {
        let needsQuote = s.contains(":") || s.contains("#") || s.contains("\"") || s.hasPrefix("[") || s.hasPrefix("@")
        if !needsQuote { return s }
        return "\"\(s.replacingOccurrences(of: "\"", with: "\\\""))\""
    }

    /// Extrait le premier lien Zoom/Meet/Teams des notes de l'event.
    private static func firstMeetingLink(in notes: String) -> String? {
        for token in notes.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "<" || $0 == ">" }) {
            let t = String(token)
            if t.hasPrefix("https://") && (t.contains("zoom.") || t.contains("meet.google") || t.contains("teams.")) {
                return t
            }
        }
        return nil
    }
}
