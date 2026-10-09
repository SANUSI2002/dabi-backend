-- Why a session ended, so a device that was signed out can tell the person why
-- (e.g. SIGNED_IN_ELSEWHERE: the account signed in on another device, which allows one at a time).
ALTER TABLE "auth_sessions" ADD COLUMN "revoked_reason" VARCHAR(32);
