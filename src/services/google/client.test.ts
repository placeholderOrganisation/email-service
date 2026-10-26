import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, connectMemoryMongo, disconnectMemoryMongo } from "../../test/mongo.js";
import { GoogleConnection } from "../../models/GoogleConnection.js";
import { clearGoogleTokenCache, defaultGoogleClient, GoogleApiError, setGoogleFetchForTests } from "./client.js";
import { storeGoogleConnection } from "./connection.js";

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let responder: (call: Call) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeAll(async () => {
  await connectMemoryMongo();
});
afterAll(async () => {
  setGoogleFetchForTests(null);
  await disconnectMemoryMongo();
});
beforeEach(async () => {
  await clearDatabase();
  clearGoogleTokenCache();
  calls = [];
  setGoogleFetchForTests(async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    return responder(call);
  });
});
afterEach(() => {
  setGoogleFetchForTests(null);
});

describe("default Google client (stubbed fetch)", () => {
  it("builds the offline-consent authorize URL", () => {
    const url = new URL(defaultGoogleClient.getAuthUrl("state-123"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(p.get("redirect_uri")).toBe("http://localhost:4100/admin/google/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("https://www.googleapis.com/auth/business.manage openid email");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("include_granted_scopes")).toBe("true");
    expect(p.get("state")).toBe("state-123");
  });

  it("exchanges a code and reads the email from the id_token", async () => {
    const idPayload = Buffer.from(JSON.stringify({ email: "op@example.com" })).toString("base64url");
    responder = () =>
      json(200, {
        access_token: "at",
        expires_in: 3599,
        refresh_token: "rt",
        scope: "openid email https://www.googleapis.com/auth/business.manage",
        id_token: `h.${idPayload}.s`,
      });
    const out = await defaultGoogleClient.exchangeCode("the-code");
    expect(out).toMatchObject({ accessToken: "at", refreshToken: "rt", email: "op@example.com" });
    expect(out.scopes).toContain("https://www.googleapis.com/auth/business.manage");
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(calls[0].init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
  });

  it("surfaces Google's error text and classifies invalid_grant as reconnect", async () => {
    responder = () => json(400, { error: "invalid_grant", error_description: "Bad Request" });
    const err = await defaultGoogleClient.exchangeCode("x").catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.kind).toBe("reconnect");
    expect(err.message).toBe("Bad Request");
  });

  it("refreshes once, caches the access token, and PUTs the reply", async () => {
    await storeGoogleConnection({ refreshToken: "rt-plain", scopes: [] });
    responder = ({ url }) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? json(200, { access_token: "at-1", expires_in: 3600 })
        : json(200, { comment: "Thanks!", updateTime: "2025-06-01T00:00:00Z" });

    const name = "accounts/1/locations/2/reviews/3";
    await defaultGoogleClient.updateReply(name, "Thanks!");
    await defaultGoogleClient.updateReply(name, "Thanks!");

    const tokenCalls = calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(new URLSearchParams(String(tokenCalls[0].init!.body)).get("refresh_token")).toBe("rt-plain");
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(put.url).toBe(`https://mybusiness.googleapis.com/v4/${name}/reply`);
    expect(JSON.parse(String(put.init!.body))).toEqual({ comment: "Thanks!" });
    expect((put.init!.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
  });

  it("retries a 401 once with a fresh token, then reports reconnect-required", async () => {
    await storeGoogleConnection({ refreshToken: "rt-plain", scopes: [] });
    responder = ({ url }) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? json(200, { access_token: "at", expires_in: 3600 })
        : json(401, { error: { message: "Request had invalid authentication credentials." } });
    const err = await defaultGoogleClient.listAccounts().catch((e) => e);
    expect(err.kind).toBe("reconnect");
    expect(err.message).toBe("Request had invalid authentication credentials.");
    expect(calls.filter((c) => c.url.startsWith("https://mybusinessaccountmanagement"))).toHaveLength(2);
    const conn = await GoogleConnection.findOne();
    expect(conn!.lastError).toContain("invalid authentication");
  });

  it("classifies 429/5xx as transient", async () => {
    await storeGoogleConnection({ refreshToken: "rt-plain", scopes: [] });
    responder = ({ url }) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? json(200, { access_token: "at", expires_in: 3600 })
        : json(429, { error: { message: "Quota exceeded" } });
    const err = await defaultGoogleClient.listReviews("accounts/1", "locations/2").catch((e) => e);
    expect(err.kind).toBe("transient");
    expect(calls.at(-1)!.url).toBe(
      "https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews?pageSize=50&orderBy=updateTime%20desc",
    );
  });

  it("paginates locations with the readMask", async () => {
    await storeGoogleConnection({ refreshToken: "rt-plain", scopes: [] });
    responder = ({ url }) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return json(200, { access_token: "at", expires_in: 3600 });
      return url.includes("pageToken=p2")
        ? json(200, { locations: [{ name: "locations/b" }] })
        : json(200, { locations: [{ name: "locations/a" }], nextPageToken: "p2" });
    };
    const locs = await defaultGoogleClient.listLocations("accounts/1");
    expect(locs.map((l) => l.name)).toEqual(["locations/a", "locations/b"]);
    expect(calls[1].url).toContain("/v1/accounts/1/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100");
  });

  it("reports not_connected without a stored token", async () => {
    responder = () => json(200, {});
    const err = await defaultGoogleClient.getAccessToken().catch((e) => e);
    expect(err.kind).toBe("not_connected");
    expect(calls).toHaveLength(0);
  });
});
