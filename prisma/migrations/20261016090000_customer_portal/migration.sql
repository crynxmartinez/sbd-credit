-- Customer portal accounts -------------------------------------------------------------------------------------------------
-- A CustomerUser is a person at a customer who may sign in to see that one customer's account. They are kept apart from
-- AppUser (staff) on purpose: no shared role column decides who can reach what.

CREATE TABLE "CustomerUser" (
    "id"             TEXT NOT NULL,
    "customerId"     TEXT NOT NULL,
    "email"          TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    -- Null until the invitation is accepted.
    "passwordHash"   TEXT,
    "active"         BOOLEAN NOT NULL DEFAULT true,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "failedLogins"   INTEGER NOT NULL DEFAULT 0,
    "lockedUntil"    TIMESTAMPTZ(3),
    "lastLoginAt"    TIMESTAMPTZ(3),
    "createdBy"      TEXT NOT NULL,
    "createdById"    TEXT,
    "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CustomerUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PortalInvite" (
    "id"             TEXT NOT NULL,
    "customerUserId" TEXT NOT NULL,
    -- SHA-256 of the token in the link. The token itself is never stored.
    "tokenHash"      TEXT NOT NULL,
    "expiresAt"      TIMESTAMPTZ(3) NOT NULL,
    "usedAt"         TIMESTAMPTZ(3),
    -- Set when a newer invitation replaces this one.
    "revokedAt"      TIMESTAMPTZ(3),
    "createdBy"      TEXT NOT NULL,
    "createdById"    TEXT,
    "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerUser_email_key" ON "CustomerUser"("email");
CREATE INDEX "CustomerUser_customerId_idx" ON "CustomerUser"("customerId");
CREATE UNIQUE INDEX "PortalInvite_tokenHash_key" ON "PortalInvite"("tokenHash");
CREATE INDEX "PortalInvite_customerUserId_idx" ON "PortalInvite"("customerUserId");

ALTER TABLE "CustomerUser"
  ADD CONSTRAINT "CustomerUser_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- One address is one account, whatever its case, and an email always has an "@" (a staff username never does).
  ADD CONSTRAINT "CustomerUser_email_check" CHECK ("email" = lower("email") AND "email" = btrim("email") AND position('@' in "email") > 1),
  ADD CONSTRAINT "CustomerUser_failed_check" CHECK ("failedLogins" >= 0),
  ADD CONSTRAINT "CustomerUser_session_check" CHECK ("sessionVersion" >= 1);

ALTER TABLE "PortalInvite"
  ADD CONSTRAINT "PortalInvite_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "CustomerUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- An invitation is used or replaced, never both.
  ADD CONSTRAINT "PortalInvite_state_check" CHECK ("usedAt" IS NULL OR "revokedAt" IS NULL),
  ADD CONSTRAINT "PortalInvite_expiry_check" CHECK ("expiresAt" > "createdAt");

-- At most ONE live invitation per person, whatever the application does. Re-sending revokes the old one in the same
-- transaction, so two links can never both work.
CREATE UNIQUE INDEX "PortalInvite_one_live_key" ON "PortalInvite"("customerUserId") WHERE "usedAt" IS NULL AND "revokedAt" IS NULL;
