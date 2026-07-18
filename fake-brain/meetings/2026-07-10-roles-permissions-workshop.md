---
date: 2026-07-10T15:00:00+02:00
title: Roles and permissions workshop
processed: true
source: synthetic
attendees: [people/nora-bellier, people/emile-rousset, people/bastien-leroux, people/camille-dervaux]
tags: [security, permissions, product]
related_projects: [permissions-core]
call_link: https://brumeline.example/meetings/2026-07-10-permissions
---

# Roles and permissions workshop

> Three roles will cover the first version, but the Manager role still requires a decision on two sensitive actions.

## Key points

- A customizable role would make migration and support too complex.
- Revocations must appear in the same log as grants.

## Decisions

- Ship Administrator, Manager, and Contributor.
- Defer custom roles until after the full migration.

## Action items

- **Nora Bellier:** decide data export and invitation rights for the Manager role.
- **Bastien Leroux:** version the audit event schema.
- **Émile Rousset:** prepare the migration of legacy permissions.

## Connections

- [[people/camille-dervaux]]
- [[people/emile-rousset]]
- [[people/bastien-leroux]]
- [[projects/permissions-core]]
