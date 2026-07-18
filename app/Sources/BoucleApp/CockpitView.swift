import SwiftUI
import WebKit

/// La fenêtre cockpit : le web UI Boucle existant, dans une coquille native.
/// Pas de barre d'URL, pas de navigateur — juste l'app.
struct CockpitView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Le web UI est local (localhost) — autorise les requêtes claires.
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    /// Recharge tout seul si le serveur n'était pas encore prêt au lancement.
    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL
        init(url: URL) { self.url = url }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            retry(webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            retry(webView)
        }

        private func retry(_ webView: WKWebView) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [url] in
                webView.load(URLRequest(url: url))
            }
        }
    }
}
