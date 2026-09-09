/**
 * Worker-side types for the email-digest feature.
 *
 * The data-shape interfaces here mirror the SERVED summaries in
 * `src/types/holdings.ts` (only the fields the digest needs). They are copied
 * rather than imported so the Worker project stays self-contained and does not
 * cross the app/worker tsconfig boundary. Keep them in sync if the derived
 * summaries change.
 */

// --- Cloudflare bindings & secrets -----------------------------------------

/**
 * Worker environment. Everything except ASSETS is OPTIONAL: the feature must
 * degrade gracefully when storage or the email secret isn't configured yet
 * (the dashboard itself never depends on any of this).
 */
export interface Env {
  /** Static-asset binding (the built client + /data summaries). Always present. */
  ASSETS: Fetcher;
  /** KV namespace holding subscriptions. Absent until the one-time setup is done. */
  DIGEST_KV?: KVNamespace;
  /** Bearer token for the Munshot email API. Absent → sending is skipped (no crash). */
  MUNS_TOKEN?: string;
  /** Shared secret guarding POST /api/run-digests (sent as the x-digest-key header). */
  DIGEST_KEY?: string;
  /** Override for the email endpoint. Defaults to the Munshot raw-send URL. */
  MUNS_EMAIL_ENDPOINT?: string;
  /** Canonical site origin (e.g. https://amfimga.example). Falls back to the request origin. */
  SITE_URL?: string;
  /** When "true", send the digest even when nothing changed (for testing). */
  SEND_EMPTY?: string;
}

/** One stored subscription. Keyed in KV as `sub:<sha256(email)>`. */
export interface Subscription {
  email: string;
  /** "weekdays" = Mon–Fri only; "daily" = every day. */
  frequency: "weekdays" | "daily";
  /** Preferred delivery time, IST, "HH:MM" (24h). */
  timeIST: string;
  /** Which digest sections to include (see SECTION_KEYS). */
  sections: string[];
  /** Random token for one-click unsubscribe. */
  token: string;
  /** Origin the person subscribed from (used to build links if SITE_URL is unset). */
  origin: string;
  createdAt: string;
  /** IST date "YYYY-MM-DD" of the last send — the once-per-day guard. */
  lastSentDate?: string;
  /** Content signature of the last digest sent — the "nothing new" gate. */
  lastVersion?: string;
}

/** The digest sections a subscriber can toggle. */
export const SECTION_KEYS = ["flows", "movers", "conviction", "entries"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

// --- Served-summary shapes (subset of src/types/holdings.ts) ----------------

export interface MonthMeta {
  month: string;
  label: string;
  housesPresent: number;
  housesTotal: number;
  fundCount: number;
  stockCount: number;
}

export interface SummaryMeta {
  schemaVersion: number;
  generatedAt: string;
  topSectors: string[];
  months: MonthMeta[];
}

export type MarketCap = "large" | "mid" | "small";

export interface StockRow {
  isin: string;
  name: string;
  macroSector: string | null;
  marketCap: MarketCap | null;
  totalValueInr: (number | null)[];
  fundCount: (number | null)[];
  netShareChange: (number | null)[];
  fundsBuying?: number | null;
  fundsSelling?: number | null;
  newEntry?: boolean;
  recentIpo?: boolean;
  listedOn?: string | null;
}

export interface StocksSummary {
  schemaVersion: number;
  months: string[];
  monthLabels: string[];
  stocks: StockRow[];
}

export interface SectorRow {
  sector: string;
  netShareChange: (number | null)[];
}

export interface SectorSummary {
  schemaVersion: number;
  months: string[];
  monthLabels: string[];
  sectors: SectorRow[];
}

export interface TrendsetterEntry {
  file: string;
  name: string;
  house: string;
  score: number;
  evaluated: number;
  examples: string[];
}

export interface ConsensusEntry {
  isin: string;
  name: string;
  sector: string | null;
  heldBy: number;
  adding: number;
}

export interface FundsIndex {
  schemaVersion: number;
  month: string;
  monthLabel: string;
  trendsetters?: TrendsetterEntry[];
  consensus?: ConsensusEntry[];
  consensusOf?: number;
}

/** The four summaries the digest is built from. */
export interface DashboardData {
  summary: SummaryMeta;
  stocks: StocksSummary;
  sectors: SectorSummary;
  funds: FundsIndex | null;
}
