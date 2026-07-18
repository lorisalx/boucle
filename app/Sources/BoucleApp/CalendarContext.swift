import EventKit
import Foundation

/// L'événement calendrier dans lequel on se trouve au moment du Record.
struct MeetingInfo {
    let title: String
    /// Participants sous forme lisible ("Nom <email>" ou l'email seul).
    let attendees: [String]
    /// Notes de l'event (contient souvent le lien Zoom/Meet).
    let notes: String?
    let start: Date
}

/// Détection native du meeting courant via EventKit. Fonctionne sans OAuth dès que
/// le compte Google est ajouté au Calendrier macOS (Réglages ▸ Comptes Internet).
enum CalendarContext {
    static let store = EKEventStore()

    /// Demande l'accès complet aux événements (prompt NSCalendarsFullAccessUsageDescription au 1er appel).
    static func requestAccess() async -> Bool {
        if #available(macOS 14.0, *) {
            return (try? await store.requestFullAccessToEvents()) ?? false
        }
        return await withCheckedContinuation { cont in
            store.requestAccess(to: .event) { granted, _ in cont.resume(returning: granted) }
        }
    }

    /// Les comptes/sources calendrier visibles (diagnostic : "Google" doit y figurer).
    static func availableAccounts() -> [String] {
        Set(store.calendars(for: .event).map { $0.source.title }).sorted()
    }

    /// L'événement en cours (ou le plus proche dans une fenêtre de ±15 min). nil si rien.
    static func currentMeeting(now: Date = Date()) -> MeetingInfo? {
        let calendars = store.calendars(for: .event)
        guard !calendars.isEmpty else { return nil }

        let predicate = store.predicateForEvents(
            withStart: now.addingTimeInterval(-15 * 60),
            end: now.addingTimeInterval(15 * 60),
            calendars: calendars
        )
        let events = store.events(matching: predicate).filter { !$0.isAllDay }

        // Priorité : un event actuellement en cours ; sinon le prochain à démarrer.
        let inProgress = events
            .filter { $0.startDate <= now && $0.endDate >= now }
            .sorted { $0.startDate > $1.startDate }
        let upcoming = events
            .filter { $0.startDate >= now }
            .sorted { $0.startDate < $1.startDate }
        guard let ev = inProgress.first ?? upcoming.first else { return nil }

        let attendees = (ev.attendees ?? []).compactMap { p -> String? in
            let email = p.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
            switch (p.name, email.isEmpty) {
            case let (name?, false): return "\(name) <\(email)>"
            case let (name?, true): return name
            case (nil, false): return email
            default: return nil
            }
        }
        return MeetingInfo(title: ev.title ?? "Meeting", attendees: attendees, notes: ev.notes, start: ev.startDate)
    }
}
