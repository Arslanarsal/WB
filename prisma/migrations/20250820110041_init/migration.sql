-- CreateTable
CREATE TABLE "public"."whats_app_session" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "serverId" INTEGER NOT NULL,
    "creds" JSONB,
    "keys" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whats_app_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whats_app_session_sessionId_key" ON "public"."whats_app_session"("sessionId");
