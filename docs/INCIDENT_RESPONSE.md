# Incident response draft

**Draft requiring organizational approval.** On a suspected security, privacy, duplicate-claim or data-integrity incident: stop submission workers; preserve the database/WAL/SHM files, relevant sanitized diagnostics and artifact checksums; record timestamps and app version; isolate affected releases; classify severity; notify the designated security/privacy owner; and do not rotate or access a Canada Post account without the authorized owner.

Containment may include disabling the update channel, clearing a local browser session, revoking a distributed artifact, or reverting to a verified backup. Recovery requires integrity checks, reconciliation of every uncertain attempt, a synthetic regression rehearsal, and explicit approval before live submission resumes. The post-incident review records timeline, impact, root cause, controls, customer notifications, retention/disposal and follow-up owners.
