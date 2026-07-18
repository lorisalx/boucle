import Foundation
import Combine

/// Orchestre un enregistrement de meeting de bout en bout :
///   start → permissions → capture micro (Moi) + audio système (Eux)
///   stop  → transcription mlx_whisper des 2 pistes → note .md dans brain/meetings/
///           (processed:false) que la loop Boucle `Meetings` ramasse ensuite.
/// Quelles pistes capter. Deux pistes (micro + audio système) ne sont propres que
/// si les deux sources ne s'entendent PAS l'une l'autre (remote au casque). Dès que
/// l'enceinte joue le son Zoom dans la même pièce que le micro, les deux se doublent
/// → écho. On choisit alors une source unique.
enum CaptureMode: String, CaseIterable, Identifiable {
    /// Micro + audio système : remote à ton bureau, au casque. Deux pistes Moi/Eux propres.
    case both
    /// Micro seul : réunion en présentiel. Le micro capte toute la salle (y compris
    /// le son Zoom sortant de l'enceinte) — pas de piste système, donc pas d'écho.
    case micOnly
    /// Audio système seul : tout le monde passe par Zoom (visio, webinaire, ou salle
    /// équipée où un AUTRE appareil injecte la pièce dans l'appel). Capture la plus
    /// propre (audio numérique par intervenant), MAIS ta propre voix micro n'est PAS
    /// captée — Zoom ne te renvoie jamais ton propre son.
    case zoomOnly

    var id: String { rawValue }
    var label: String {
        switch self {
        case .both:     return "Micro + Zoom (remote au casque)"
        case .micOnly:  return "Micro seul (salle de réunion)"
        case .zoomOnly: return "Zoom seul (tout le monde en visio)"
        }
    }
    var usesMic: Bool { self != .zoomOnly }
    var usesSystem: Bool { self != .micOnly }
}

@MainActor
final class Recorder: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var statusLine = ""

    /// Quelles pistes on capte. Persisté pour survivre aux redémarrages.
    @Published var mode: CaptureMode =
        CaptureMode(rawValue: UserDefaults.standard.string(forKey: "captureMode") ?? "") ?? .both {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "captureMode") }
    }

    private let mic = MicCapture()
    private let system = SystemAudioCapture()

    private var startedAt: Date?
    private var sessionDir: URL?
    private var meeting: MeetingInfo?
    private var ticker: AnyCancellable?

    /// Coupure des pistes du meeting précédent (rapide). Un meeting enchaîné attend qu'elle
    /// soit finie avant de réutiliser les instances mic/système partagées — mais PAS la
    /// transcription, qui, elle, part en fond. `nil` tant qu'aucun meeting ne s'est terminé.
    private var teardownTask: Task<Void, Never>?

    /// File série pour la transcription : elle isole le travail lourd et bloquant
    /// (mlx_whisper, plusieurs minutes pour 1 h) hors du main actor, et garantit que
    /// deux meetings enchaînés ne transcrivent jamais en même temps (l'un attend l'autre).
    private static let transcriptionQueue = DispatchQueue(label: "boucle.transcription")

    func start() {
        guard !isRecording else { return }
        Task { await beginCapture() }
    }

    func stop() {
        guard isRecording else { return }
        isRecording = false
        ticker?.cancel(); ticker = nil

        // Fige la session qui vient de s'achever et libère aussitôt l'état partagé :
        // un meeting enchaîné peut ainsi redémarrer l'enregistrement pendant que
        // celui-ci se transcrit en arrière-plan.
        guard let dir = sessionDir, let start = startedAt else { return }
        let endedMeeting = meeting
        sessionDir = nil
        startedAt = nil
        meeting = nil

        statusLine = "Arrêt des pistes…"
        teardownTask = Task {
            // Coupe les pistes tout de suite (rapide) sur le main actor, pour que les
            // instances mic/système soient libres avant que le meeting suivant les réutilise.
            let micWrote = mic.stop()
            let sysWrote = await system.stop()
            // Puis délègue la transcription à la file de fond : la menu bar reste réactive
            // (transcribeAndWrite dépose le travail et rend la main aussitôt).
            transcribeAndWrite(dir: dir, start: start, meeting: endedMeeting, micWrote: micWrote, sysWrote: sysWrote)
        }
    }

    // MARK: - Capture lifecycle

    private func beginCapture() async {
        // Enchaînement dos à dos : attends que la coupure des pistes du meeting précédent
        // soit terminée avant de réutiliser les instances mic/système (sinon on courrait le
        // risque que son `stop()` annule le stream qu'on vient de démarrer). Rapide — on
        // n'attend jamais la transcription, qui tourne en fond.
        await teardownTask?.value
        teardownTask = nil

        // La permission micro n'est requise que si le mode capte le micro : en
        // « Zoom seul » un micro refusé ne doit pas bloquer l'enregistrement.
        if mode.usesMic {
            guard await MicCapture.requestPermission() else {
                statusLine = "Micro refusé — Réglages ▸ Confidentialité ▸ Micro"
                return
            }
        }

        // Détection du meeting en cours (best-effort — n'empêche jamais l'enregistrement).
        var detected: MeetingInfo?
        if await CalendarContext.requestAccess() {
            NSLog("[Boucle] comptes calendrier: %@", CalendarContext.availableAccounts().joined(separator: ", "))
            detected = CalendarContext.currentMeeting()
        }
        self.meeting = detected

        let start = Date()
        let dir = sessionURL(for: start)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            // Chaque piste n'est démarrée que si le mode la demande. Capter les deux
            // dans une même pièce (enceinte + micro) crée un écho — d'où les modes
            // « micro seul » (présentiel) et « Zoom seul » (tout le monde en visio).
            if mode.usesMic {
                try mic.start(to: dir.appendingPathComponent("moi.wav"))
            }
            if mode.usesSystem {
                do {
                    try await system.start(to: dir.appendingPathComponent("eux.wav"))
                } catch {
                    // La piste système peut échouer (permission écran manquante).
                    if mode == .zoomOnly {
                        statusLine = "Audio système indispo — vérifie la permission d'enregistrement d'écran"
                    } else {
                        statusLine = "Audio système indispo (permission écran ?) — micro seul"
                    }
                    NSLog("[Boucle] system audio start failed: %@", error.localizedDescription)
                }
            }
        } catch {
            statusLine = "Démarrage capture échoué : \(error.localizedDescription)"
            return
        }

        startedAt = start
        sessionDir = dir
        isRecording = true
        ticker = Timer.publish(every: 1, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in self?.refreshStatus() }
        refreshStatus()
    }

    /// Transcrit les deux pistes puis écrit la note markdown — sur la file série de fond.
    /// Ne touche NI aux instances de capture NI à l'état d'enregistrement (déjà libérés par
    /// `stop()`) : seul le `statusLine` est mis à jour, en repassant par le main actor.
    /// Un meeting enchaîné peut donc tourner pendant que celui-ci se transcrit.
    private func transcribeAndWrite(dir: URL, start: Date, meeting: MeetingInfo?, micWrote: Bool, sysWrote: Bool) {
        Recorder.transcriptionQueue.async { [weak self] in
            func status(_ line: String) { Task { @MainActor in self?.statusLine = line } }

            status("Transcription (whisper)…")
            do {
                let micSegs = micWrote
                    ? try Transcriber.transcribe(wav: dir.appendingPathComponent("moi.wav"), speaker: "Moi") : []
                let sysSegs = sysWrote
                    ? try Transcriber.transcribe(wav: dir.appendingPathComponent("eux.wav"), speaker: "Eux") : []
                let url = try MeetingNote.write(mic: micSegs, system: sysSegs, startedAt: start, meeting: meeting)
                status("Écrit : \(url.lastPathComponent) — la loop prendra le relais")
                Notifier.post(title: "Meeting transcrit", body: url.lastPathComponent)
                // La note est écrite : les WAV bruts + le JSON whisper ne servent plus (plusieurs Go
                // par heure). On supprime le dossier de session. En cas d'échec on le GARDE, pour
                // pouvoir rejouer/déboguer la transcription sans avoir perdu l'audio.
                try? FileManager.default.removeItem(at: dir)
            } catch {
                status("Transcription échouée : \(error.localizedDescription)")
                NSLog("[Boucle] transcription/write failed: %@", error.localizedDescription)
            }
        }
    }

    // MARK: - Helpers

    private func sessionURL(for date: Date) -> URL {
        let df = DateFormatter(); df.dateFormat = "yyyyMMdd-HHmmss"
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Boucle/sessions", isDirectory: true)
        return base.appendingPathComponent(df.string(from: date), isDirectory: true)
    }

    private func refreshStatus() {
        guard let startedAt else { return }
        let elapsed = Int(Date().timeIntervalSince(startedAt))
        let clock = String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
        if let title = meeting?.title {
            statusLine = "● \(title) — \(clock)"
        } else {
            statusLine = "En cours — \(clock)"
        }
    }
}
