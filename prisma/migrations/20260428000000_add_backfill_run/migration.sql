-- CreateTable
CREATE TABLE "BackfillRun" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "since" TIMESTAMP(3),
    "until" TIMESTAMP(3),
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "bulkOperationIdOrders" TEXT,
    "bulkOperationIdCustomers" TEXT,
    "jsonlOffsetOrders" INTEGER NOT NULL DEFAULT 0,
    "jsonlOffsetCustomers" INTEGER NOT NULL DEFAULT 0,
    "ordersProcessed" INTEGER NOT NULL DEFAULT 0,
    "refundsProcessed" INTEGER NOT NULL DEFAULT 0,
    "cancellationsProcessed" INTEGER NOT NULL DEFAULT 0,
    "identifiesProcessed" INTEGER NOT NULL DEFAULT 0,
    "excludedAlreadyCaptured" INTEGER NOT NULL DEFAULT 0,
    "preflightSnapshot" JSONB,
    "postflightSnapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BackfillRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackfillRun_shop_status_idx" ON "BackfillRun"("shop", "status");
