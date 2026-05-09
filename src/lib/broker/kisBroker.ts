import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import type { BrokerClient, BrokerStatus } from "@/lib/broker/broker";
import type {
  AccountSummary,
  OrderRequest,
  OrderResult,
  Quote,
} from "@/lib/types/trading";

type KisTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error_description?: string;
  msg1?: string;
};

type KisApiResponse<TOutput> = {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  output?: TOutput;
};

type KisQuoteOutput = {
  hts_kor_isnm?: string;
  stck_prpr?: string;
  prdy_ctrt?: string;
};

type KisBalancePositionOutput = {
  pdno?: string;
  prdt_name?: string;
  hldg_qty?: string;
  pchs_avg_pric?: string;
  prpr?: string;
};

type KisBalanceSummaryOutput = {
  dnca_tot_amt?: string;
  tot_evlu_amt?: string;
  scts_evlu_amt?: string;
};

type KisBalanceResponse = Omit<KisApiResponse<never>, "output"> & {
  output1?: KisBalancePositionOutput[];
  output2?: KisBalanceSummaryOutput[];
  ctx_area_fk100?: string;
  ctx_area_nk100?: string;
};

type KisHashResponse = {
  HASH?: string;
  hash?: string;
};

type KisOrderOutput = {
  KRX_FWDG_ORD_ORGNO?: string;
  ODNO?: string;
  ORD_TMD?: string;
};

type KisTokenCache = {
  accessToken: string;
  expiresAt: number;
  appKey: string;
  mode: string;
} | null;

const tokenCacheKey = "__stockAutoTraderKisTokenCache";

function getTokenCacheFile() {
  if (process.env.KIS_TOKEN_CACHE_PATH) {
    return process.env.KIS_TOKEN_CACHE_PATH;
  }

  const cacheRoot = process.env.VERCEL ? "/tmp" : path.join(process.cwd(), ".next", "cache");
  return path.join(cacheRoot, "kis-token.json");
}

function getTokenCache() {
  return (globalThis as typeof globalThis & Record<string, KisTokenCache>)[tokenCacheKey] ?? null;
}

function setTokenCache(cache: Exclude<KisTokenCache, null>) {
  (globalThis as typeof globalThis & Record<string, KisTokenCache>)[tokenCacheKey] = cache;
}

function isUsableTokenCache(cache: KisTokenCache): cache is Exclude<KisTokenCache, null> {
  return Boolean(
    cache &&
      cache.appKey === env.BROKER_APP_KEY &&
      cache.mode === env.TRADING_MODE &&
      cache.expiresAt > Date.now() + 60_000,
  );
}

async function readTokenCacheFile() {
  try {
    const raw = await readFile(getTokenCacheFile(), "utf8");
    const cache = JSON.parse(raw) as KisTokenCache;
    return isUsableTokenCache(cache) ? cache : null;
  } catch {
    return null;
  }
}

async function writeTokenCacheFile(cache: Exclude<KisTokenCache, null>) {
  const tokenCacheFile = getTokenCacheFile();
  await mkdir(path.dirname(tokenCacheFile), { recursive: true });
  await writeFile(tokenCacheFile, JSON.stringify(cache), { mode: 0o600 });
}

function getKisBaseUrl() {
  if (env.KIS_BASE_URL) {
    return env.KIS_BASE_URL;
  }

  return env.TRADING_MODE === "live"
    ? "https://openapi.koreainvestment.com:9443"
    : "https://openapivts.koreainvestment.com:29443";
}

function assertKisCredentials() {
  if (!env.BROKER_APP_KEY || !env.BROKER_APP_SECRET) {
    throw new Error("KIS app key and app secret are required.");
  }
}

function getAccountParts() {
  const accountNo = env.BROKER_ACCOUNT_NO.replaceAll("-", "").trim();

  if (!/^\d{8}$/.test(accountNo)) {
    throw new Error("BROKER_ACCOUNT_NO must be the 8-digit KIS account number.");
  }

  return {
    accountNo,
    productCode: env.KIS_ACCOUNT_PRODUCT_CODE,
  };
}

function parseNumber(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getOrderDivision(order: OrderRequest) {
  return order.type === "market" ? "01" : "00";
}

function getOrderUnitPrice(order: OrderRequest) {
  if (order.type === "market") {
    return "0";
  }

  return String(order.limitPrice ?? 0);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as
    | (T & { error_description?: string; msg1?: string; msg_cd?: string })
    | null;

  if (!response.ok) {
    throw new Error(
      data?.error_description ??
        data?.msg1 ??
        `KIS request failed with HTTP ${response.status}.`,
    );
  }

  if (!data) {
    throw new Error("KIS returned an empty response.");
  }

  return data as T;
}

export class KisBrokerClient implements BrokerClient {
  private readonly baseUrl = getKisBaseUrl();

  async getStatus(): Promise<BrokerStatus> {
    try {
      await this.getAccessToken();

      return {
        provider: env.BROKER_PROVIDER,
        connected: true,
        mode: env.TRADING_MODE,
        message: "KIS broker authentication succeeded.",
      };
    } catch (error) {
      return {
        provider: env.BROKER_PROVIDER,
        connected: false,
        mode: env.TRADING_MODE,
        message: error instanceof Error ? error.message : "KIS broker authentication failed.",
      };
    }
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const accessToken = await this.getAccessToken();
    const { accountNo, productCode } = getAccountParts();
    const positions: KisBalancePositionOutput[] = [];
    let summary: KisBalanceSummaryOutput | undefined;
    let nextContextAreaFk100 = "";
    let nextContextAreaNk100 = "";
    let trCont: string | undefined;

    do {
      const url = new URL("/uapi/domestic-stock/v1/trading/inquire-balance", this.baseUrl);
      url.searchParams.set("CANO", accountNo);
      url.searchParams.set("ACNT_PRDT_CD", productCode);
      url.searchParams.set("AFHR_FLPR_YN", "N");
      url.searchParams.set("OFL_YN", "");
      url.searchParams.set("INQR_DVSN", "01");
      url.searchParams.set("UNPR_DVSN", "01");
      url.searchParams.set("FUND_STTL_ICLD_YN", "N");
      url.searchParams.set("FNCG_AMT_AUTO_RDPT_YN", "N");
      url.searchParams.set("PRCS_DVSN", "00");
      url.searchParams.set("CTX_AREA_FK100", nextContextAreaFk100);
      url.searchParams.set("CTX_AREA_NK100", nextContextAreaNk100);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          authorization: `Bearer ${accessToken}`,
          appkey: env.BROKER_APP_KEY ?? "",
          appsecret: env.BROKER_APP_SECRET ?? "",
          tr_id: env.TRADING_MODE === "live" ? "TTTC8434R" : "VTTC8434R",
          ...(trCont ? { tr_cont: trCont } : {}),
          custtype: "P",
        },
        cache: "no-store",
      });

      const data = await readJsonResponse<KisBalanceResponse>(response);

      if (data.rt_cd && data.rt_cd !== "0") {
        throw new Error(data.msg1 ?? `KIS balance request failed (${data.msg_cd ?? "unknown"}).`);
      }

      positions.push(...(data.output1 ?? []));
      summary = data.output2?.[0] ?? summary;
      nextContextAreaFk100 = data.ctx_area_fk100 ?? "";
      nextContextAreaNk100 = data.ctx_area_nk100 ?? "";
      trCont = response.headers.get("tr_cont") === "F" ? "N" : undefined;
    } while (trCont);

    return {
      accountNo,
      cash: parseNumber(summary?.dnca_tot_amt),
      currency: env.TRADING_BASE_CURRENCY,
      totalMarketValue: parseNumber(summary?.tot_evlu_amt ?? summary?.scts_evlu_amt),
      positions: positions
        .filter((position) => parseNumber(position.hldg_qty) > 0)
        .map((position) => ({
          symbol: position.pdno ?? "",
          name: position.prdt_name ?? position.pdno ?? "",
          quantity: parseNumber(position.hldg_qty),
          averagePrice: parseNumber(position.pchs_avg_pric),
          currentPrice: parseNumber(position.prpr),
          currency: env.TRADING_BASE_CURRENCY,
        })),
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    const accessToken = await this.getAccessToken();
    const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-price", this.baseUrl);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
    url.searchParams.set("FID_INPUT_ISCD", symbol);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${accessToken}`,
        appkey: env.BROKER_APP_KEY ?? "",
        appsecret: env.BROKER_APP_SECRET ?? "",
        tr_id: "FHKST01010100",
        custtype: "P",
      },
      cache: "no-store",
    });

    const data = await readJsonResponse<KisApiResponse<KisQuoteOutput>>(response);

    if (data.rt_cd && data.rt_cd !== "0") {
      throw new Error(data.msg1 ?? `KIS quote request failed (${data.msg_cd ?? "unknown"}).`);
    }

    const output = data.output;

    if (!output) {
      throw new Error("KIS quote response did not include output.");
    }

    return {
      symbol,
      name: output.hts_kor_isnm ?? symbol,
      market: "KR",
      price: parseNumber(output.stck_prpr),
      changeRate: parseNumber(output.prdy_ctrt),
      currency: "KRW",
      timestamp: new Date().toISOString(),
    };
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (env.TRADING_MODE === "live" && !env.ALLOW_LIVE_TRADING) {
      return {
        orderId: `kis-blocked-${Date.now()}`,
        accepted: false,
        mode: env.TRADING_MODE,
        message: "Live KIS order placement is disabled. Set ALLOW_LIVE_TRADING=true to enable it.",
        requestedAt: new Date().toISOString(),
      };
    }

    const accessToken = await this.getAccessToken();
    const { accountNo, productCode } = getAccountParts();
    const body = {
      CANO: accountNo,
      ACNT_PRDT_CD: productCode,
      PDNO: order.symbol,
      ORD_DVSN: getOrderDivision(order),
      ORD_QTY: String(order.quantity),
      ORD_UNPR: getOrderUnitPrice(order),
      CTAC_TLNO: "",
      SLL_TYPE: order.side === "sell" ? "01" : undefined,
      ALGO_NO: "",
    };
    const hashKey = await this.createHashKey(body);
    const response = await fetch(new URL("/uapi/domestic-stock/v1/trading/order-cash", this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${accessToken}`,
        appkey: env.BROKER_APP_KEY ?? "",
        appsecret: env.BROKER_APP_SECRET ?? "",
        tr_id: this.getOrderTrId(order),
        custtype: "P",
        hashkey: hashKey,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const data = await readJsonResponse<KisApiResponse<KisOrderOutput>>(response);
    const accepted = data.rt_cd === "0";
    const orderNo = data.output?.ODNO;
    const forwardingOrgNo = data.output?.KRX_FWDG_ORD_ORGNO;

    return {
      orderId: orderNo ? [forwardingOrgNo, orderNo].filter(Boolean).join("-") : `kis-${Date.now()}`,
      accepted,
      mode: env.TRADING_MODE,
      message: data.msg1 ?? (accepted ? "KIS order accepted." : "KIS order rejected."),
      requestedAt: new Date().toISOString(),
    };
  }

  private getOrderTrId(order: OrderRequest) {
    if (env.TRADING_MODE === "live") {
      return order.side === "buy" ? "TTTC0802U" : "TTTC0801U";
    }

    return order.side === "buy" ? "VTTC0802U" : "VTTC0801U";
  }

  private async createHashKey(body: Record<string, string | undefined>) {
    assertKisCredentials();

    const response = await fetch(new URL("/uapi/hashkey", this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        appkey: env.BROKER_APP_KEY ?? "",
        appsecret: env.BROKER_APP_SECRET ?? "",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const data = await readJsonResponse<KisHashResponse>(response);
    const hashKey = data.HASH ?? data.hash;

    if (!hashKey) {
      throw new Error("KIS hashkey response did not include HASH.");
    }

    return hashKey;
  }

  private async getAccessToken() {
    assertKisCredentials();
    const cachedToken = getTokenCache();

    if (isUsableTokenCache(cachedToken)) {
      return cachedToken.accessToken;
    }

    const storedToken = await readTokenCacheFile();

    if (storedToken) {
      setTokenCache(storedToken);
      return storedToken.accessToken;
    }

    const response = await fetch(new URL("/oauth2/tokenP", this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: env.BROKER_APP_KEY,
        appsecret: env.BROKER_APP_SECRET,
      }),
      cache: "no-store",
    });

    const data = await readJsonResponse<KisTokenResponse>(response);

    if (!data.access_token) {
      throw new Error(
        data.error_description ?? data.msg1 ?? "KIS token response did not include access_token.",
      );
    }

    const nextCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + Math.max((data.expires_in ?? 86_400) - 60, 60) * 1000,
      appKey: env.BROKER_APP_KEY ?? "",
      mode: env.TRADING_MODE,
    };

    setTokenCache(nextCache);
    await writeTokenCacheFile(nextCache);

    return nextCache.accessToken;
  }
}
