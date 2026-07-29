/**
 * Dedicated adapter for Singapore's LTA COE (Certificate of Entitlement)
 * Category D (motorcycles) bidding results.
 *
 * The OneMotoring page the user pointed at does have this data, but as
 * server-rendered HTML <table> markup — a structure the generic web-scraper
 * adapter doesn't parse (it only handles <article>/JSON-LD/card patterns).
 * Rather than teach the scraper tables for one source, this pulls the same
 * data from data.gov.sg's structured dataset API instead.
 *
 * IMPORTANT: the poll-download endpoint returns a short-lived, AWS-signed S3
 * URL (SigV4 query params: AWSAccessKeyId/Signature/x-amz-security-token).
 * That URL must never be persisted — not in CollectedSignal.url, not in
 * rawMeta, not logged — same class of leak as the AI News project's AWS-key
 * incident. It's used once to fetch the CSV and then discarded; only the
 * derived data and the stable dataset page URL are kept.
 */

import type { CollectedSignal, SourceDescriptor } from "../types.js";
import type { SourceAdapter } from "./types.js";

const DATASET_ID = "d_69b3380ad7e51aff3a7dcc84eba52b8a";
const POLL_DOWNLOAD_URL = `https://api-open.data.gov.sg/v1/public/api/datasets/${DATASET_ID}/poll-download`;
const DATASET_PAGE_URL = `https://data.gov.sg/datasets/${DATASET_ID}/view`;
const VEHICLE_CLASS = "Category D";
const ROUNDS_TO_REPORT = 2;

interface CoeRow {
  month: string;
  biddingNo: string;
  quota: number;
  bidsSuccess: number;
  bidsReceived: number;
  premium: number;
}

export const ltaCoeAdapter: SourceAdapter = {
  kind: "lta-coe",
  async collect(source, context) {
    const pollResponse = await context.fetchText(POLL_DOWNLOAD_URL);
    const parsed = JSON.parse(pollResponse.body) as { data?: { url?: string } };
    const downloadUrl = parsed.data?.url;
    if (!downloadUrl) throw new Error("data.gov.sg poll-download response missing a download URL");

    const csvResponse = await context.fetchText(downloadUrl);
    const rows = parseCoeRows(csvResponse.body).slice(-ROUNDS_TO_REPORT);
    return rows.length === 0 ? [] : [buildSignal(source, rows)];
  },
};

function parseCoeRows(csv: string): CoeRow[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]?.split(",") ?? [];
  const col = (name: string) => header.indexOf(name);
  const monthIdx = col("month");
  const biddingNoIdx = col("bidding_no");
  const classIdx = col("vehicle_class");
  const quotaIdx = col("quota");
  const successIdx = col("bids_success");
  const receivedIdx = col("bids_received");
  const premiumIdx = col("premium");

  const rows: CoeRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells[classIdx] !== VEHICLE_CLASS) continue;
    rows.push({
      month: cells[monthIdx] ?? "",
      biddingNo: cells[biddingNoIdx] ?? "",
      quota: Number(cells[quotaIdx]),
      bidsSuccess: Number(cells[successIdx]),
      bidsReceived: Number(cells[receivedIdx]),
      premium: Number(cells[premiumIdx]),
    });
  }
  return rows;
}

function buildSignal(source: SourceDescriptor, rounds: CoeRow[]): CollectedSignal {
  const last = rounds[rounds.length - 1]!;
  const summary = rounds
    .map(
      (r) =>
        `${r.month} 第${r.biddingNo}轮：中标价 S$${r.premium.toLocaleString()}（配额 ${r.quota}，收到投标 ${r.bidsReceived} 份，中标 ${r.bidsSuccess} 份）`,
    )
    .join("；");
  return {
    externalId: `lta-coe-${last.month}-${last.biddingNo}`,
    url: DATASET_PAGE_URL,
    title: `新加坡 COE Category D（摩托车）最新中标价：S$${last.premium.toLocaleString()}（${last.month} 第${last.biddingNo}轮）`,
    summary,
    language: source.language,
    publishedAt: monthToIsoDate(last.month),
    category: source.config.category ?? "local-market",
    tags: ["coe", "singapore"],
    metrics: {},
    rawMeta: { dataSource: "data.gov.sg", datasetId: DATASET_ID },
  };
}

function monthToIsoDate(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
