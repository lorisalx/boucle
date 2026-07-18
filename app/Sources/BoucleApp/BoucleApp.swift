import SwiftUI

/// Boucle.app — le visage natif du cerveau Boucle.
///
/// Deux rôles, une seule app :
///   • un item menu bar (record/stop + statut) — l'interrupteur ;
///   • une fenêtre cockpit (WKWebView sur le web UI Boucle) — le dashboard.
///
/// Le serveur Boucle (TS/launchd) reste inchangé : cette app ne fait que
/// l'afficher et lui parler en HTTP.
@main
struct BoucleApp: App {
    /// L'URL du web UI servi par le serveur Boucle local.
    static let cockpitURL = URL(string: "http://localhost:4319")!

    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var recorder = Recorder()

    var body: some Scene {
        // WindowGroup => icône dans le Dock + fenêtre cockpit + ⌘Tab.
        WindowGroup("Boucle") {
            CockpitView(url: Self.cockpitURL)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1200, height: 800)
        .windowResizability(.contentMinSize)

        // MenuBarExtra => icône en haut à droite, indépendante de la fenêtre.
        MenuBarExtra {
            MenuBarContent(recorder: recorder)
        } label: {
            Image(systemName: recorder.isRecording ? "record.circle.fill" : "brain.head.profile")
        }
        .menuBarExtraStyle(.menu)
    }
}

/// Force la présence dans le Dock (`.regular`) même si la fenêtre est fermée,
/// et garde l'app vivante quand on ferme la dernière fenêtre (menu bar-only).
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
