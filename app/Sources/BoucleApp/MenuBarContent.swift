import SwiftUI

/// Le contenu du menu déroulant de la menu bar : l'interrupteur meeting + accès cockpit.
struct MenuBarContent: View {
    @ObservedObject var recorder: Recorder
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if recorder.isRecording {
            Button("● Arrêter le meeting") { recorder.stop() }
            Text(recorder.statusLine)
        } else {
            Button("● Enregistrer un meeting") { recorder.start() }
        }

        Divider()

        // Choix des pistes : deux pistes (Micro + Zoom) ne sont propres qu'au casque en
        // remote ; dans une pièce l'enceinte revient dans le micro → écho, d'où les
        // modes à source unique. Verrouillé pendant l'enregistrement.
        Picker("Capture", selection: $recorder.mode) {
            ForEach(CaptureMode.allCases) { m in
                Text(m.label).tag(m)
            }
        }
        .pickerStyle(.inline)
        .disabled(recorder.isRecording)

        Divider()

        Button("Ouvrir le cockpit") {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "Boucle")
        }

        Divider()

        Button("Quitter Boucle") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
