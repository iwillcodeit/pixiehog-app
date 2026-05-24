/**
 * Bulk operation runner — wraps Shopify's `bulkOperationRunQuery` mutation +
 * `currentBulkOperation` poll loop and exposes a streaming JSONL reader.
 *
 * Usage from orchestrator:
 *
 *   const bulkOpId = await startBulkOp(admin, buildOrdersBulkQuery(filter));
 *   const url = await waitForBulkOp(admin, bulkOpId);
 *   for await (const node of streamJsonl(url, { offset })) {
 *     ...
 *   }
 */

import { CURRENT_BULK_OPERATION_QUERY } from "./queries";

// `admin.graphql` is the Shopify admin GraphQL helper returned by
// `authenticate.admin(request)`. Typed loosely so we don't drag the
// shopify-app-remix types into common.server.
export interface AdminGraphqlClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

interface BulkOperationStatus {
  id: string;
  status: "CREATED" | "RUNNING" | "COMPLETED" | "CANCELED" | "EXPIRED" | "FAILED";
  errorCode: string | null;
  objectCount: string | null;
  fileSize: string | null;
  url: string | null;
  partialDataUrl: string | null;
}

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 60 * 60 * 1_000; // 1h cap; Shopify bulks can run long.

/**
 * Kicks off a bulk operation. Returns the operation `id` once Shopify has
 * accepted it. Throws on userErrors or a missing bulkOperation in the response.
 */
export async function startBulkOp(
  admin: AdminGraphqlClient,
  mutationQuery: string,
): Promise<string> {
  const res = await admin.graphql(mutationQuery);
  const body = (await res.json()) as {
    data?: {
      bulkOperationRunQuery?: {
        bulkOperation?: { id: string; status: string };
        userErrors?: Array<{ field: string[]; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(`bulkOperationRunQuery error: ${body.errors.map((e) => e.message).join("; ")}`);
  }

  const result = body.data?.bulkOperationRunQuery;
  if (result?.userErrors?.length) {
    throw new Error(
      `bulkOperationRunQuery userErrors: ${result.userErrors
        .map((e) => `${e.field?.join(".") ?? "?"}: ${e.message}`)
        .join("; ")}`,
    );
  }
  if (!result?.bulkOperation?.id) {
    throw new Error("bulkOperationRunQuery returned no bulkOperation");
  }
  return result.bulkOperation.id;
}

/**
 * Polls `currentBulkOperation` until it reaches a terminal state. Returns the
 * download URL on COMPLETED, throws otherwise.
 *
 * NOTE: Shopify's `currentBulkOperation` returns the most-recent bulk op for
 * the shop, so this only works when the orchestrator gates concurrent runs.
 */
export async function waitForBulkOp(
  admin: AdminGraphqlClient,
  expectedId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const start = Date.now();
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? POLL_TIMEOUT_MS;

  while (true) {
    const res = await admin.graphql(CURRENT_BULK_OPERATION_QUERY);
    const body = (await res.json()) as { data?: { currentBulkOperation?: BulkOperationStatus | null } };
    const op = body.data?.currentBulkOperation;
    if (!op) throw new Error("currentBulkOperation returned null");

    if (op.id !== expectedId) {
      // Shouldn't happen if the orchestrator gates concurrency, but bail loudly.
      throw new Error(`currentBulkOperation id ${op.id} != expected ${expectedId}`);
    }

    if (op.status === "COMPLETED") {
      if (!op.url) throw new Error("Bulk op completed but no url");
      return op.url;
    }
    if (op.status === "CANCELED" || op.status === "FAILED" || op.status === "EXPIRED") {
      throw new Error(`Bulk op ${op.id} terminal status=${op.status} errorCode=${op.errorCode ?? ""}`);
    }

    if (Date.now() - start > timeout) {
      throw new Error(`Bulk op ${op.id} timed out after ${timeout}ms (status=${op.status})`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Async-iterates JSONL lines from the signed Shopify download URL. Skips the
 * first `offset` lines so the orchestrator can resume mid-file after a crash.
 *
 * Each yielded value is the parsed JSON object plus its 1-based line index.
 */
export async function* streamJsonl(
  url: string,
  opts: { offset?: number } = {},
): AsyncGenerator<{ line: number; node: Record<string, unknown> }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`JSONL download failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const skip = opts.offset ?? 0;
  let buffer = "";
  let lineIdx = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!raw) continue;
      lineIdx++;
      if (lineIdx <= skip) continue;
      try {
        yield { line: lineIdx, node: JSON.parse(raw) };
      } catch (err) {
        throw new Error(`JSONL parse failed at line ${lineIdx}: ${(err as Error).message}`);
      }
    }
  }

  // Trailing partial line, if any.
  const tail = buffer.trim();
  if (tail) {
    lineIdx++;
    if (lineIdx > skip) {
      try {
        yield { line: lineIdx, node: JSON.parse(tail) };
      } catch (err) {
        throw new Error(`JSONL parse error at line ${lineIdx}: ${(err as Error).message}`);
      }
    }
  }
}
