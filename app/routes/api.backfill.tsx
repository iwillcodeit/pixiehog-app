/**
 * POST /api/backfill — kicks off a backfill run.
 *
 * Body (JSON):
 *   {
 *     since?: string;       // ISO date, optional lower bound
 *     until?: string;       // ISO date, optional upper bound
 *     dryRun?: boolean;     // when true, the orchestrator logs but does not POST to PostHog
 *     personalApiKey: string; // PostHog personal API key for the HogQL exclude-set query
 *     projectId: string;      // PostHog project numeric id
 *     force?: boolean;        // bypasses the active-run guard
 *   }
 *
 * Returns: `{ runId, status }` immediately. The orchestrator runs out-of-band
 * (fire-and-forget). Poll BackfillRun via Prisma for progress.
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  createBackfillRun,
  findActiveRun,
  setStatus,
} from "../common.server/backfill/state";
import { runBackfill } from "../common.server/backfill/orchestrator";
import type { ExcludeSetCredentials } from "../common.server/backfill/exclude-set";

interface PostBody {
  since?: string;
  until?: string;
  dryRun?: boolean;
  personalApiKey?: string;
  projectId?: string;
  force?: boolean;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return json({ ok: false, message: "invalid JSON body" }, { status: 400 });
  }

  if (!body.personalApiKey || !body.projectId) {
    return json({ ok: false, message: "personalApiKey and projectId are required" }, { status: 400 });
  }

  const shopRow = await db.shop.findUnique({ where: { shop: shopDomain } });
  if (!shopRow?.posthogApiKey || !shopRow.posthogApiHost) {
    return json({ ok: false, message: "PostHog not configured for this shop" }, { status: 400 });
  }

  // Active-run guard
  if (!body.force) {
    const active = await findActiveRun(shopDomain);
    if (active) {
      return json(
        { ok: false, message: `Run ${active.id} already ${active.status}; pass force=true to override` },
        { status: 409 },
      );
    }
  }

  const since = body.since ? new Date(body.since) : null;
  const until = body.until ? new Date(body.until) : null;
  if (since && isNaN(since.getTime())) {
    return json({ ok: false, message: "invalid since date" }, { status: 400 });
  }
  if (until && isNaN(until.getTime())) {
    return json({ ok: false, message: "invalid until date" }, { status: 400 });
  }
  if (since && until && since >= until) {
    return json({ ok: false, message: "since must be before until" }, { status: 400 });
  }

  const run = await createBackfillRun({
    shop: shopDomain,
    since,
    until,
    dryRun: body.dryRun ?? true,
  });

  const excludeSetCreds: ExcludeSetCredentials = {
    personalApiKey: body.personalApiKey,
    projectId: body.projectId,
    apiHost: shopRow.posthogApiHost,
  };

  // Fire and forget — orchestrator persists progress via state.ts.
  runBackfill({
    runId: run.id,
    shop: shopRow,
    admin,
    excludeSetCreds,
    since,
    until,
    dryRun: run.dryRun,
  }).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[backfill] run ${run.id} failed:`, message);
    await setStatus(run.id, "failed", message).catch(() => {});
  });

  return json({ ok: true, runId: run.id, status: run.status });
};
