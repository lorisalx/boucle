---
date: 2026-07-17T14:30:00+02:00
title: Launch security review
processed: true
source: synthetic
attendees: [people/camille-dervaux, people/nora-bellier, people/emile-rousset, people/bastien-leroux]
tags: [security, launch, review]
related_projects: [permissions-core, partner-portal, helium-migration]
call_link: https://brumeline.example/meetings/2026-07-17-security
---

# Launch security review

> The Hélium Migration can continue its controlled waves; the Partner Portal will depend on the new Permissions Core before its beta.

## Key points

- The Hélium checks cover integrity and rollback.
- Partner access must not reuse legacy permission exceptions.

## Decisions

- Authorize the second Hélium wave after validating the workspace list.
- Make the partner role a profile in the new core, not a separate exception.

## Action items

- **Nora Bellier:** present the minimum matrix for the Manager role.
- **Émile Rousset:** connect the partner prototype to the new access control.
- **Bastien Leroux:** add revocations to the audit test plan.

## Connections

- [[people/camille-dervaux]]
- [[people/emile-rousset]]
- [[people/bastien-leroux]]
- [[projects/permissions-core]]
- [[projects/partner-portal]]
- [[projects/helium-migration]]
