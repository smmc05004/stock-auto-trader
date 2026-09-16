import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dailyOrderSchema, buyingPowerSchema, minuteBarSchema, type PaperDailyOrder } from "./paperOrders";
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

function getKisCredentials() {
  if (env.TRADING_MODE === "live") {
    return {
      appKey: env.KIS_LIVE_APP_KEY ?? env.BROKER_APP_KEY,
      appSecret: env.KIS_LIVE_APP_SECRET ?? env.BROKER_APP_SECRET,
      accountNo: env.KIS_LIVE_ACCOUNT_NO ?? env.BROKER_ACCOUNT_NO,
      productCode: env.KIS_LIVE_ACCOUNT_PRODUCT_CODE ?? env.KIS_ACCOUNT_PRODUCT_CODE,
    };
  }

  return {
    appKey: env.KIS_PAPER_APP_KEY ?? env.BROKER_APP_KEY,
    appSecret: env.KIS_PAPER_APP_SECRET ?? env.BROKER_APP_SECRET,
    accountNo: env.KIS_PAPER_ACCOUNT_NO ?? env.BROKER_ACCOUNT_NO,
    productCode: env.KIS_PAPER_ACCOUNT_PRODUCT_CODE ?? env.KIS_ACCOUNT_PRODUCT_CODE,
  };
}

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
  const { appKey } = getKisCredentials();

  return Boolean(
    cache &&
      cache.appKey === appKey &&
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
  const { appKey, appSecret } = getKisCredentials();

  if (!appKey || !appSecret) {
    throw new Error(`KIS ${env.TRADING_MODE} app key and app secret are required.`);
  }
}

function getAccountParts() {
  const { accountNo: rawAccountNo, productCode } = getKisCredentials();
  const accountNo = rawAccountNo.replaceAll("-", "").trim();

  if (!/^\d{8}$/.test(accountNo)) {
    throw new Error(`KIS ${env.TRADING_MODE} account number must be the 8-digit account number.`);
  }

  return {
    accountNo,
    productCode,
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

  const price = order.limitPrice ?? 0;
  const tick = price < 2_000 ? 1
    : price < 5_000 ? 5
      : price < 20_000 ? 10
        : price < 50_000 ? 50
          : price < 200_000 ? 100
            : price < 500_000 ? 500
              : price < 1_000_000 ? 1_000
                : price < 2_000_000 ? 2_000 : 5_000;
  return String(Math.floor(price / tick) * tick);
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

  private async paperGet(endpoint: string, trId: string, parameters: Record<string, string>, continuation?: string) {
    if (env.TRADING_MODE !== "paper" || env.ALLOW_LIVE_TRADING || env.KIS_BASE_URL) {
      throw new Error("Paper account queries require the standard paper environment.");
    }
    const token = await this.getAccessToken();
    const { appKey, appSecret } = getKisCredentials();
    const url = new URL(endpoint, this.baseUrl);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    await delay(1100);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, appkey: appKey ?? "", appsecret: appSecret ?? "",
        tr_id: trId, custtype: "P", ...(continuation ? { tr_cont: continuation } : {}) },
      signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    const data = await readJsonResponse<Record<string, unknown>>(response);
    if (data.rt_cd !== "0") throw new Error(`Paper query failed: ${String(data.msg_cd ?? "unknown")}`);
    return { data, more: ["F", "M"].includes(response.headers.get("tr_cont") ?? "") };
  }

  async getPaperDailyOrders(startDate: string, endDate: string): Promise<PaperDailyOrder[]> {
    const { accountNo, productCode } = getAccountParts();
    const orders: PaperDailyOrder[] = [];
    let fk = "", nk = "";
    for (let page = 0; page < 20; page++) {
      const { data, more } = await this.paperGet("/uapi/domestic-stock/v1/trading/inquire-daily-ccld", "VTTC0081R", {
        CANO: accountNo, ACNT_PRDT_CD: productCode, INQR_STRT_DT: startDate, INQR_END_DT: endDate,
        SLL_BUY_DVSN_CD: "00", PDNO: "", CCLD_DVSN: "00", INQR_DVSN: "00", INQR_DVSN_3: "00",
        ORD_GNO_BRNO: "", ODNO: "", INQR_DVSN_1: "", CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
      }, page ? "N" : undefined);
      if (!Array.isArray(data.output1)) throw new Error("Missing daily orders output.");
      orders.push(...data.output1.map((row) => dailyOrderSchema.parse(row)));
      if (!more) return orders;
      const nextFk = String(data.ctx_area_fk100 ?? ""), nextNk = String(data.ctx_area_nk100 ?? "");
      if (nextFk === fk && nextNk === nk) throw new Error("Repeated daily orders cursor.");
      fk = nextFk; nk = nextNk;
    }
    throw new Error("Daily orders pagination exceeded its limit.");
  }

  async getPaperBuyingPower(symbol: string, price: number) {
    const { accountNo, productCode } = getAccountParts();
    const { data } = await this.paperGet("/uapi/domestic-stock/v1/trading/inquire-psbl-order", "VTTC8908R", {
      CANO: accountNo, ACNT_PRDT_CD: productCode, PDNO: symbol, ORD_UNPR: String(price),
      ORD_DVSN: "01", CMA_EVLU_AMT_ICLD_YN: "N", OVRS_ICLD_YN: "N",
    });
    return buyingPowerSchema.parse(data.output);
  }

  async getPaperLatestBar(symbol: string, hour: string) {
    const { data } = await this.paperGet("/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice", "FHKST03010200", {
      FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol, FID_INPUT_HOUR_1: hour,
      FID_PW_DATA_INCU_YN: "N", FID_ETC_CLS_CODE: "",
    });
    if (!Array.isArray(data.output2) || !data.output2.length) throw new Error("No recent trading bars.");
    const bars = data.output2.map((row) => minuteBarSchema.parse(row))
      .filter((bar) => bar.cntg_vol > 0 && bar.stck_cntg_hour.slice(0, 4) < hour.slice(0, 4))
      .sort((a, b) => `${b.stck_bsop_date}${b.stck_cntg_hour}`.localeCompare(`${a.stck_bsop_date}${a.stck_cntg_hour}`));
    if (!bars.length) throw new Error("No completed bar with trading volume.");
    return bars[0];
  }

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
      const { appKey, appSecret } = getKisCredentials();
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
          appkey: appKey ?? "",
          appsecret: appSecret ?? "",
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
    const { appKey, appSecret } = getKisCredentials();
    const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-price", this.baseUrl);
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
    url.searchParams.set("FID_INPUT_ISCD", symbol);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${accessToken}`,
        appkey: appKey ?? "",
        appsecret: appSecret ?? "",
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
    const { appKey, appSecret } = getKisCredentials();
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
      EXCG_ID_DVSN_CD: "KRX",
      CNDT_PRIC: "",
    };
    const hashKey = await this.createHashKey(body);
    const response = await fetch(new URL("/uapi/domestic-stock/v1/trading/order-cash", this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${accessToken}`,
        appkey: appKey ?? "",
        appsecret: appSecret ?? "",
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

    return order.side === "buy" ? "VTTC0012U" : "VTTC0011U";
  }

  private async createHashKey(body: Record<string, string | undefined>) {
    assertKisCredentials();
    const { appKey, appSecret } = getKisCredentials();

    const response = await fetch(new URL("/uapi/hashkey", this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        appkey: appKey ?? "",
        appsecret: appSecret ?? "",
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

  async getAccessToken(forceRefresh = false) {
    assertKisCredentials();
    const { appKey, appSecret } = getKisCredentials();
    const cachedToken = getTokenCache();

    if (!forceRefresh && isUsableTokenCache(cachedToken)) {
      return cachedToken.accessToken;
    }

    const storedToken = await readTokenCacheFile();

    if (!forceRefresh && storedToken) {
      setTokenCache(storedToken);
      return storedToken.accessToken;
    }

    const response = await fetch(new URL("/oauth2/tokenP", this.baseUrl), {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: appKey,
        appsecret: appSecret,
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
      appKey: appKey ?? "",
      mode: env.TRADING_MODE,
    };

    setTokenCache(nextCache);
    await writeTokenCacheFile(nextCache);

    return nextCache.accessToken;
  }
}
