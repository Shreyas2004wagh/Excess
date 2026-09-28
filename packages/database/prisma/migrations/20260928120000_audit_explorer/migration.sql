CREATE INDEX "AuditEvent_createdAt_id_idx" ON "AuditEvent"("createdAt", "id");
CREATE INDEX "AuditEvent_action_createdAt_id_idx" ON "AuditEvent"("action", "createdAt", "id");
