-- Baileys getMessage DB fallback cache
CREATE TABLE "wb_messages_cache" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "message" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wb_messages_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uniq_wb_msg_cache_session_message" ON "wb_messages_cache"("sessionId", "messageId");
CREATE INDEX "idx_wb_msg_cache_sessionId" ON "wb_messages_cache"("sessionId");
CREATE INDEX "idx_wb_msg_cache_createdAt" ON "wb_messages_cache"("createdAt");
