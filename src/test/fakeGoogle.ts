import {
  GoogleApiError,
  defaultGoogleClient,
  type GoogleAccount,
  type GoogleClient,
  type GoogleLocation,
  type GoogleReview,
  type GoogleReviewReply,
  type GoogleTokenExchange,
} from "../services/google/client.js";

export const ACCOUNT = "accounts/111";
export const LOCATION = "locations/222";

/** Builds an API review for ACCOUNT/LOCATION. */
export function apiReview(id: string, overrides: Partial<GoogleReview> = {}): GoogleReview {
  return {
    name: `${ACCOUNT}/${LOCATION}/reviews/${id}`,
    reviewId: id,
    reviewer: { displayName: "Alice Example" },
    starRating: "FIVE",
    comment: `Great service from review ${id}`,
    createTime: "2025-03-01T12:00:00.000Z",
    updateTime: "2025-03-01T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * In-memory stand-in for the Google client. Reviews are served newest
 * updateTime first, `pageSize` per page, like the real v4 endpoint.
 */
export function createFakeGoogle() {
  const fake = {
    accounts: [{ name: ACCOUNT, accountName: "Operator Account" }] as GoogleAccount[],
    locations: {
      [ACCOUNT]: [
        {
          name: LOCATION,
          title: "Alpha Co Downtown",
          storefrontAddress: { addressLines: ["1 Main St"], locality: "Springfield", administrativeArea: "IL" },
          metadata: { placeId: "place-alpha" },
        },
        { name: "locations/333", title: "Bravo Co" },
      ],
    } as Record<string, GoogleLocation[]>,
    reviews: [] as GoogleReview[],
    pageSize: 50,
    exchange: {
      accessToken: "fake-access-token",
      expiresIn: 3600,
      refreshToken: "1//fake-refresh-token-PLAINTEXT",
      scopes: ["https://www.googleapis.com/auth/business.manage", "openid", "email"],
      email: "operator@example.com",
    } as GoogleTokenExchange,
    listReviewsCalls: [] as { accountName: string; locationName: string; pageToken?: string }[],
    updateReplyCalls: [] as { reviewName: string; comment: string }[],
    revokeCalls: 0,
    exchangeCalls: [] as string[],
    updateReplyError: null as GoogleApiError | null,
    listReviewsError: null as Error | null,
    /** Awaited inside listReviews — lets a test hold a sync "running". */
    listReviewsGate: null as Promise<void> | null,
    client: undefined as unknown as GoogleClient,
  };

  fake.client = {
    getAuthUrl: defaultGoogleClient.getAuthUrl,
    async exchangeCode(code) {
      fake.exchangeCalls.push(code);
      return fake.exchange;
    },
    async getAccessToken() {
      return "fake-access-token";
    },
    async revoke() {
      fake.revokeCalls += 1;
    },
    async listAccounts() {
      return fake.accounts;
    },
    async listLocations(accountName) {
      return fake.locations[accountName] ?? [];
    },
    async listReviews(accountName, locationName, pageToken) {
      fake.listReviewsCalls.push({ accountName, locationName, pageToken });
      if (fake.listReviewsGate) await fake.listReviewsGate;
      if (fake.listReviewsError) throw fake.listReviewsError;
      const prefix = `${accountName}/${locationName}/reviews/`;
      const sorted = fake.reviews
        .filter((r) => r.name.startsWith(prefix))
        .sort((a, b) => Date.parse(b.updateTime) - Date.parse(a.updateTime));
      const start = pageToken ? Number(pageToken) : 0;
      const page = sorted.slice(start, start + fake.pageSize);
      const next = start + fake.pageSize < sorted.length ? String(start + fake.pageSize) : undefined;
      return { reviews: page, nextPageToken: next, totalReviewCount: sorted.length };
    },
    async updateReply(reviewName, comment): Promise<GoogleReviewReply> {
      fake.updateReplyCalls.push({ reviewName, comment });
      if (fake.updateReplyError) throw fake.updateReplyError;
      return { comment, updateTime: "2025-06-01T09:30:00.000Z" };
    },
  };

  return fake;
}

export type FakeGoogle = ReturnType<typeof createFakeGoogle>;
