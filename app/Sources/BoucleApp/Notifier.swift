import Foundation
import UserNotifications

/// Notifications natives best-effort. Si le centre de notifications n'est pas
/// disponible (app non enregistrée, permission refusée), on log et on continue —
/// jamais de crash.
enum Notifier {
    static func post(title: String, body: String) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request, withCompletionHandler: nil)
        }
    }
}
