---
date: 2026-07-10T15:00:00+02:00
title: Atelier des rôles et permissions
processed: true
source: synthetic
attendees: [people/nora-bellier, people/emile-rousset, people/bastien-leroux, people/camille-dervaux]
tags: [securite, permissions, produit]
related_projects: [socle-permissions]
call_link: https://brumeline.example/meetings/2026-07-10-permissions
---

# Atelier des rôles et permissions

> Trois rôles couvriront la première version, mais le rôle Responsable nécessite encore un arbitrage sur deux actions sensibles.

## Key points

- Un rôle personnalisable rendrait la migration et le support trop complexes.
- Les révocations doivent apparaître dans le même journal que les attributions.

## Decisions

- Livrer Administrateur, Responsable et Contributeur.
- Différer les rôles personnalisés après la migration complète.

## Action items

- **Nora Bellier:** arbitrer l'export de données et l'invitation pour le rôle Responsable.
- **Bastien Leroux:** versionner le schéma des événements d'audit.
- **Émile Rousset:** préparer la migration des permissions historiques.

## Connections

- [[people/camille-dervaux]]
- [[people/emile-rousset]]
- [[people/bastien-leroux]]
- [[projects/socle-permissions]]

