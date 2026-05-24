/**
 * Admin UI — /app/backfill
 *
 * Lets the operator pick a date window, toggle dryRun, paste a PostHog
 * personal API key + project id (needed only for the HogQL exclude-set
 * query), and kick off a run. Renders a polling dashboard with the latest
 * `BackfillRun` row counters.
 */

import { useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Banner,
  Box,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  Page,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const recent = await db.backfillRun.findMany({
    where: { shop: session.shop },
    orderBy: { startedAt: "desc" },
    take: 5,
  });
  return json({
    runs: recent.map((r) => ({
      id: r.id,
      status: r.status,
      since: r.since?.toISOString() ?? null,
      until: r.until?.toISOString() ?? null,
      dryRun: r.dryRun,
      ordersProcessed: r.ordersProcessed,
      refundsProcessed: r.refundsProcessed,
      cancellationsProcessed: r.cancellationsProcessed,
      identifiesProcessed: r.identifiesProcessed,
      excludedAlreadyCaptured: r.excludedAlreadyCaptured,
      error: r.error,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  });
};

export default function BackfillPage() {
  const { runs } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; message?: string; runId?: string }>();

  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [personalApiKey, setPersonalApiKey] = useState("");
  const [projectId, setProjectId] = useState("");

  const submit = () => {
    if (!personalApiKey || !projectId) {
      window.shopify.toast.show("personalApiKey and projectId are required", { isError: true });
      return;
    }
    if (!dryRun && !window.confirm("⚠️ LIVE BACKFILL: This will write real data to PostHog and cannot be undone. Continue?")) {
      return;
    }
    fetcher.submit(
      JSON.stringify({
        since: since || undefined,
        until: until || undefined,
        dryRun,
        personalApiKey,
        projectId,
      }),
      { method: "POST", action: "/api/backfill", encType: "application/json" },
    );
  };

  // Toast on response
  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    if (data.ok) {
      window.shopify.toast.show(`Run ${data.runId} kicked off`);
    } else {
      window.shopify.toast.show(data.message ?? "Failed", { isError: true });
    }
  }, [fetcher.data]);

  // Auto-poll every 5s while the latest run is pending or running
  const revalidator = useRevalidator();
  const latest = runs[0];
  const isActive = latest?.status === "pending" || latest?.status === "running";

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 5_000);
    return () => clearInterval(interval);
  }, [isActive, revalidator]);

  return (
    <Page
      title="PostHog Historical Backfill"
      primaryAction={{
        content: "Run backfill",
        onAction: submit,
        disabled: fetcher.state !== "idle",
      }}
    >
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <BlockStack gap="500">
              <Banner tone="warning" title="Phase 0 must be deployed first">
                <p>
                  Verify <code>generateOrderEventUUID</code> + <code>generateRefundUUID</code>{" "}
                  are live and at least 24h have passed before running a non-dry
                  backfill.
                </p>
              </Banner>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Run parameters
                  </Text>
                  <TextField
                    label="Since (ISO date, optional)"
                    autoComplete="off"
                    value={since}
                    onChange={setSince}
                    placeholder="2025-01-01"
                    helpText="Lower bound on Shopify created_at"
                  />
                  <TextField
                    label="Until (ISO date, optional)"
                    autoComplete="off"
                    value={until}
                    onChange={setUntil}
                    placeholder="2026-04-14"
                    helpText="Upper bound (exclusive)"
                  />
                  <Checkbox
                    label="Dry run (log only, no PostHog writes)"
                    checked={dryRun}
                    onChange={setDryRun}
                  />
                  <TextField
                    label="PostHog personal API key"
                    autoComplete="off"
                    value={personalApiKey}
                    onChange={setPersonalApiKey}
                    placeholder="phx_…"
                    helpText="Needed for the exclude-set HogQL query. Not stored."
                    type="password"
                  />
                  <TextField
                    label="PostHog project id"
                    autoComplete="off"
                    value={projectId}
                    onChange={setProjectId}
                    placeholder="103976"
                  />
                </BlockStack>
              </Card>

              {latest ? (
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between">
                      <Text as="h3" variant="headingMd">
                        Latest run · {latest.status}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {latest.startedAt}
                      </Text>
                    </InlineStack>
                    {latest.error ? (
                      <Banner tone="critical">{latest.error}</Banner>
                    ) : null}

                    {latest.status === "pending" && (
                      <InlineStack gap="200" blockAlign="center">
                        <Spinner size="small" />
                        <Text as="span" variant="bodySm">
                          Starting...
                        </Text>
                      </InlineStack>
                    )}

                    {latest.status === "running" && (
                      <InlineStack gap="200" blockAlign="center">
                        <Spinner size="small" />
                        <Text as="span" variant="bodySm">
                          Orders: {latest.ordersProcessed} · Refunds:{" "}
                          {latest.refundsProcessed} · Cancellations:{" "}
                          {latest.cancellationsProcessed} · Identifies:{" "}
                          {latest.identifiesProcessed} · Excluded:{" "}
                          {latest.excludedAlreadyCaptured}
                        </Text>
                      </InlineStack>
                    )}

                    {latest.status === "completed" && (
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="success">Completed</Badge>
                        <Text as="span" variant="bodySm">
                          Orders: {latest.ordersProcessed} · Refunds:{" "}
                          {latest.refundsProcessed} · Cancellations:{" "}
                          {latest.cancellationsProcessed} · Identifies:{" "}
                          {latest.identifiesProcessed} · Excluded:{" "}
                          {latest.excludedAlreadyCaptured}
                        </Text>
                      </InlineStack>
                    )}

                    {latest.status === "failed" && (
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone="critical">Failed</Badge>
                        <Text as="span" variant="bodySm">
                          {latest.error ?? "Unknown error"}
                        </Text>
                      </InlineStack>
                    )}
                  </BlockStack>
                </Card>
              ) : (
                <Card>
                  <Text as="p">No runs yet.</Text>
                </Card>
              )}

              {runs.length > 1 ? (
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Previous runs
                    </Text>
                    {runs.slice(1).map((r) => (
                      <Text as="p" key={r.id} variant="bodySm">
                        {r.startedAt} · {r.status} · orders={r.ordersProcessed} ·
                        identifies={r.identifiesProcessed}
                      </Text>
                    ))}
                  </BlockStack>
                </Card>
              ) : null}

              <Button url="/app">Back to overview</Button>
            </BlockStack>
          </Layout.Section>
        </Layout>
        <Box paddingBlockEnd="800" />
      </BlockStack>
    </Page>
  );
}
