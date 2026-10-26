import { describe, expect, it } from "vitest";
import { apiReview } from "../../test/fakeGoogle.js";
import { extractOriginalText, mapGoogleReview } from "./mapReview.js";

describe("mapGoogleReview", () => {
  it("maps the star enum to 1..5", () => {
    const stars = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 } as const;
    for (const [starRating, value] of Object.entries(stars)) {
      const mapped = mapGoogleReview(apiReview("r", { starRating: starRating as keyof typeof stars }));
      expect(mapped!.input.rating).toBe(value);
    }
  });

  it("skips STAR_RATING_UNSPECIFIED (and a missing rating)", () => {
    expect(mapGoogleReview(apiReview("r", { starRating: "STAR_RATING_UNSPECIFIED" }))).toBeNull();
    expect(mapGoogleReview(apiReview("r", { starRating: undefined }))).toBeNull();
  });

  it("maps ids, dates and source", () => {
    const mapped = mapGoogleReview(apiReview("abc123", { createTime: "2024-05-06T07:08:09.000Z" }))!;
    expect(mapped.input.externalReviewId).toBe("abc123");
    expect(mapped.input.source).toBe("google");
    expect(mapped.input.reviewedAt!.toISOString()).toBe("2024-05-06T07:08:09.000Z");
    expect(mapped.google.reviewName).toBe("accounts/111/locations/222/reviews/abc123");
    expect(mapped.google.updateTime.toISOString()).toBe("2025-03-01T12:00:00.000Z");
  });

  it("falls back to the resource name when reviewId is absent", () => {
    const mapped = mapGoogleReview(apiReview("zzz", { reviewId: undefined }))!;
    expect(mapped.input.externalReviewId).toBe("zzz");
  });

  it("uses 'Anonymous' for anonymous or nameless reviewers", () => {
    expect(mapGoogleReview(apiReview("r", { reviewer: { displayName: "Real Name", isAnonymous: true } }))!.input.author.name)
      .toBe("Anonymous");
    expect(mapGoogleReview(apiReview("r", { reviewer: { displayName: "  " } }))!.input.author.name).toBe("Anonymous");
    expect(mapGoogleReview(apiReview("r", { reviewer: undefined }))!.input.author.name).toBe("Anonymous");
  });

  it("keeps the original-language text of a translated comment", () => {
    const comment = "(Translated by Google) Excellent place, friendly staff\n\n(Original)\nExcelente lugar, personal amable";
    expect(mapGoogleReview(apiReview("r", { comment }))!.input.text).toBe("Excelente lugar, personal amable");
  });

  it("strips a leading '(Translated by Google)' marker when there is no original section", () => {
    expect(extractOriginalText("(Translated by Google) Very good")).toBe("Very good");
  });

  it("drops a trailing translated section after the original", () => {
    expect(extractOriginalText("Muy bueno\n\n(Translated by Google)\nVery good")).toBe("Muy bueno");
  });

  it("maps a rating-only review to empty text with no owner response", () => {
    const mapped = mapGoogleReview(apiReview("r", { comment: undefined, starRating: "FOUR" }))!;
    expect(mapped.input.text).toBe("");
    expect(mapped.input.rating).toBe(4);
    expect(mapped.input.ownerResponse).toBeUndefined();
    expect(mapped.google.replyUpdateTime).toBeUndefined();
  });

  it("maps reviewReply to ownerResponse", () => {
    const mapped = mapGoogleReview(
      apiReview("r", { reviewReply: { comment: "Thanks Alice!", updateTime: "2025-03-02T10:00:00.000Z" } }),
    )!;
    expect(mapped.input.ownerResponse!.text).toBe("Thanks Alice!");
    expect(mapped.input.ownerResponse!.postedAt!.toISOString()).toBe("2025-03-02T10:00:00.000Z");
    expect(mapped.google.replyUpdateTime!.toISOString()).toBe("2025-03-02T10:00:00.000Z");
  });
});
