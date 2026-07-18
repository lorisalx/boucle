---
date: 2026-07-17T14:30:00+02:00
title: Revue sécurité des lancements
processed: true
source: synthetic
attendees: [people/camille-dervaux, people/nora-bellier, people/emile-rousset, people/bastien-leroux]
tags: [securite, lancement, revue]
related_projects: [socle-permissions, portail-partenaire, migration-helium]
call_link: https://brumeline.example/meetings/2026-07-17-securite
---

# Revue sécurité des lancements

> La migration Hélium peut poursuivre ses vagues contrôlées; le portail partenaire dépendra du nouveau socle de permissions avant sa bêta.

## Key points

- Les contrôles Hélium couvrent l'intégrité et le retour arrière.
- L'accès partenaire ne doit pas réutiliser les exceptions historiques de permissions.

## Decisions

- Autoriser la deuxième vague Hélium après validation de la liste des espaces.
- Faire du rôle partenaire un profil du nouveau socle, pas une exception séparée.

## Action items

- **Nora Bellier:** présenter la matrice minimale du rôle Responsable.
- **Émile Rousset:** relier le prototype partenaire au nouveau contrôle d'accès.
- **Bastien Leroux:** ajouter les révocations au plan de test d'audit.

## Connections

- [[people/camille-dervaux]]
- [[people/emile-rousset]]
- [[people/bastien-leroux]]
- [[projects/socle-permissions]]
- [[projects/portail-partenaire]]
- [[projects/migration-helium]]
