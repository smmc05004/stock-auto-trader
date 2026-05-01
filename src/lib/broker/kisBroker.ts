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

let cachedToken: {
  accessToken: string;
  expiresAt: number;
} | null = null;

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

function parseNumber(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as T | null;

  if (!response.ok) {
    throw new Error(`KIS request failed with HTTP ${response.status}.`);
  }

  if (!data) {
    throw new Error("KIS returned an empty response.");
  }

  return data;
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
    return {
      accountNo: env.BROKER_ACCOUNT_NO,
      cash: 0,
      currency: env.TRADING_BASE_CURRENCY,
      totalMarketValue: 0,
      positions: [],
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
    return {
      orderId: `kis-disabled-${Date.now()}`,
      accepted: false,
      mode: env.TRADING_MODE,
      message: `KIS order placement is not implemented yet. ${order.side.toUpperCase()} ${order.quantity} ${order.symbol} was not sent.`,
      requestedAt: new Date().toISOString(),
    };
  }

  private async getAccessToken() {
    assertKisCredentials();

    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
      return cachedToken.accessToken;
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

    cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + Math.max((data.expires_in ?? 86_400) - 60, 60) * 1000,
    };

    return cachedToken.accessToken;
  }
}
