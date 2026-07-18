---
date: 2026-07-08T10:00:00+02:00
title: Hélium first-wave preparation
processed: true
source: synthetic
attendees: [people/emile-rousset, people/bastien-leroux, people/maelle-courtois, people/nora-bellier]
tags: [migration, reliability, customers]
related_projects: [helium-migration]
call_link: https://brumeline.example/meetings/2026-07-08-helium
---

# Hélium first-wave preparation

> Four low-complexity workspaces will make up the first wave, with an explicit checkpoint and rollback in under fifteen minutes.

## Key points

- Workspaces with a legacy integration are excluded from the first wave.
- Maëlle will notify the account managers without announcing any expected downtime.

## Decisions

- Launch four workspaces on a Tuesday morning.
- Roll back if two consecutive consistency checks fail.

## Action items

- **Émile Rousset:** finalize the rollback command.
- **Bastien Leroux:** publish the checks dashboard.
- **Maëlle Courtois:** confirm the four workspaces with their account managers.

## Connections

- [[people/emile-rousset]]
- [[people/bastien-leroux]]
- [[people/maelle-courtois]]
- [[projects/helium-migration]]
