/**
 * Prisma helpers for `BackfillRun`. Centralises status transitions so the
 * orchestrator stays focused on the streaming + capture loop.
 */

import db from "../../db.server";

export type BackfillStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface CreateBackfillRunInput {
  shop: string;
  since: Date | null;
  until: Date | null;
  dryRun: boolean;
}

export async function createBackfillRun(input: CreateBackfillRunInput) {
  return db.backfillRun.create({
    data: {
      shop: input.shop,
      since: input.since,
      until: input.until,
      dryRun: input.dryRun,
      status: "pending",
    },
  });
}

export async function findResumableRun(shop: string) {
  return db.backfillRun.findFirst({
    where: { shop, status: "running" },
    orderBy: { startedAt: "desc" },
  });
}

export async function findActiveRun(shop: string) {
  return db.backfillRun.findFirst({
    where: { shop, status: { in: ["pending", "running"] } },
    orderBy: { startedAt: "desc" },
  });
}

export async function setStatus(id: string, status: BackfillStatus, error?: string) {
  return db.backfillRun.update({
    where: { id },
    data: {
      status,
      error: error ?? null,
      ...(status === "completed" || status === "failed" || status === "cancelled"
        ? { finishedAt: new Date() }
        : {}),
    },
  });
}

export async function recordOrdersBulkOp(id: string, bulkOpId: string) {
  return db.backfillRun.update({
    where: { id },
    data: { bulkOperationIdOrders: bulkOpId, status: "running" },
  });
}

export async function recordCustomersBulkOp(id: string, bulkOpId: string) {
  return db.backfillRun.update({
    where: { id },
    data: { bulkOperationIdCustomers: bulkOpId },
  });
}

export interface CounterDelta {
  ordersProcessed?: number;
  refundsProcessed?: number;
  cancellationsProcessed?: number;
  identifiesProcessed?: number;
  excludedAlreadyCaptured?: number;
}

export async function bumpCounters(
  id: string,
  delta: CounterDelta,
  jsonlOffsetOrders?: number,
  jsonlOffsetCustomers?: number,
) {
  return db.backfillRun.update({
    where: { id },
    data: {
      ordersProcessed: delta.ordersProcessed != null ? { increment: delta.ordersProcessed } : undefined,
      refundsProcessed: delta.refundsProcessed != null ? { increment: delta.refundsProcessed } : undefined,
      cancellationsProcessed:
        delta.cancellationsProcessed != null ? { increment: delta.cancellationsProcessed } : undefined,
      identifiesProcessed:
        delta.identifiesProcessed != null ? { increment: delta.identifiesProcessed } : undefined,
      excludedAlreadyCaptured:
        delta.excludedAlreadyCaptured != null ? { increment: delta.excludedAlreadyCaptured } : undefined,
      ...(jsonlOffsetOrders != null ? { jsonlOffsetOrders } : {}),
      ...(jsonlOffsetCustomers != null ? { jsonlOffsetCustomers } : {}),
    },
  });
}

export async function recordSnapshot(
  id: string,
  which: "preflight" | "postflight",
  snapshot: unknown,
) {
  return db.backfillRun.update({
    where: { id },
    data: {
      [which === "preflight" ? "preflightSnapshot" : "postflightSnapshot"]:
        snapshot as never,
    },
  });
}
