-- Who acted: staff, a customer, or the system. Until now an event only stored a name and an id, and a customer's id (from
-- the portal) sat in the same column as staff ids with nothing to say which kind it was.
--
-- Nullable on purpose: AuditEvent is append-only (a trigger refuses UPDATE), so events written before this column cannot be
-- back-filled. NULL means "written before actors were classified". New events always set it.
ALTER TABLE "AuditEvent" ADD COLUMN "actorKind" TEXT;

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_actorKind_check" CHECK ("actorKind" IS NULL OR "actorKind" IN ('staff', 'customer', 'system', 'anonymous'));
