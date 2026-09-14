// Review analysis + reply drafting. Ported from local-lead-finder's compose.js
// pattern: live OpenAI when a key is present (JSON mode, strict system prompt),
// deterministic mock otherwise so dev + tests run without burning tokens.

import OpenAI from "openai";
import { env } from "../config/env.js";

export interface ReviewInput {
  rating: number;
  text: string;
  author?: { name?: string | null } | null;
  language?: string | null;
}

export interface AnalysisResult {
  sentiment: string;
  topics: string[];
  summary: string;
  suggestedTone: string;
  model: string;
  generatedAt: Date;
}

export interface ReplyResult {
  body: string;
  model: string;
  generatedAt: Date;
}

export interface ProjectContext {
  name?: string | null;
  replyGuidelines?: string | null;
}

const ANALYSIS_SYSTEM_PROMPT = `You analyze a single customer review of a local business. Return a JSON object with keys:
sentiment (one of "positive", "neutral", "negative"),
topics (array of 1-5 short lowercase theme strings, e.g. "pricing", "wait time", "staff"),
summary (one concise sentence summarizing the review),
suggestedTone (one short phrase describing how the business should respond, e.g. "warm and grateful", "apologetic and solution-focused").
Base sentiment primarily on the star rating and the text. Be objective. Do not invent facts not in the review. Return ONLY the JSON object.`;

const REPLY_SYSTEM_PROMPT = `You write a public reply from a local business to one customer review. Return a JSON object with a single key "body".

Voice:
- Sound like a real owner typing a Google reply, not a template and not an AI. Vary the opening and sentence shape every time.
- If the review has text: 2-4 sentences and mention 1-2 specifics from it (a service, wait, price, whatever they actually said).
- Named people in the review (CPAs, accountants, staff) ARE the business, not a third party. The customer's experience is with us. You may thank them for mentioning a teammate, but never frame it as an experience "with" that person.
  Wrong: "Asha, I'm thrilled to hear about your positive experience with Khushpreet!"
  Right: "Asha, I'm thrilled to hear about your positive experience with us!"
- If the review has no text (rating-only): 1-2 sentences. Thank them for the rating. Do not invent what they experienced.
- Use the reviewer's first name when given. Never invent a last name or any fact not in the review.
- Match the requested tone and any replyGuidelines.
- Use plain punctuation a person would type: commas, periods, hyphens. Never use an em dash (—) or en dash (–). If you would pause, use a comma or start a new sentence.

Never:
- Write "your experience with [staff name]" or "working with [staff name]" as if they were a separate practice. Use "us" or the business name.
- Default to "thank you so much for the N-star review", "your kind words", or "we look forward to seeing you again". Those closers are banned as a formula.
- Mention the star count unless the review has no text.
- Argue, be defensive, offer dollar amounts, or use placeholders like [Name] or [Business].
- Copy or closely paraphrase any of the recentReplies. A reader should not think two replies were the same draft.

Return ONLY the JSON object.`;

function client(): OpenAI {
  return new OpenAI({ apiKey: env.openai.apiKey, baseURL: env.openai.baseUrl });
}

// ---- Analysis ----

/**
 * Classify sentiment + extract themes/summary/suggested tone for one review.
 * Falls back to a deterministic mock when no key is configured or the live call
 * fails, so the pipeline always produces a usable analysis.
 */
export async function analyzeReview(review: ReviewInput): Promise<AnalysisResult> {
  if (!env.openai.apiKey) return mockAnalysis(review);
  try {
    return await liveAnalysis(review);
  } catch (err) {
    console.warn(`[ai] analyzeReview OpenAI failed (${errMessage(err)}); using mock fallback`);
    return mockAnalysis(review);
  }
}

async function liveAnalysis(review: ReviewInput): Promise<AnalysisResult> {
  const model = env.openai.model;
  const completion = await client().chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({ rating: review.rating, text: review.text, language: review.language ?? undefined }),
      },
    ],
  });
  const parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}") as Record<string, unknown>;
  const sentiment = normalizeSentiment(str(parsed.sentiment), review.rating);
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.map((t) => str(t)).filter(Boolean).slice(0, 5)
    : deriveTopics(review);
  return {
    sentiment,
    topics: topics.length ? topics : deriveTopics(review),
    summary: str(parsed.summary) || defaultSummary(review, sentiment),
    suggestedTone: str(parsed.suggestedTone) || defaultTone(sentiment),
    model,
    generatedAt: new Date(),
  };
}

/** Deterministic analysis — used when OPENAI_API_KEY is absent, and by tests. */
export function mockAnalysis(review: ReviewInput): AnalysisResult {
  const sentiment = sentimentFromRating(review.rating);
  return {
    sentiment,
    topics: deriveTopics(review),
    summary: defaultSummary(review, sentiment),
    suggestedTone: defaultTone(sentiment),
    model: "mock",
    generatedAt: new Date(),
  };
}

// ---- Reply generation ----

export interface ReplyGenerationInput {
  review: ReviewInput;
  analysis: Pick<AnalysisResult, "sentiment" | "suggestedTone"> &
    Partial<Pick<AnalysisResult, "topics" | "summary">>;
  project: ProjectContext;
  /** Other recent drafts for this business — used so bulk imports don't chorus. */
  recentReplies?: string[];
}

/**
 * Draft an on-brand reply to a review, using the project's voice guidelines and
 * the analysis's suggested tone. Never modifies the original review text. Falls
 * back to a deterministic templated reply when no key/failure.
 */
export async function generateReply(input: ReplyGenerationInput): Promise<ReplyResult> {
  if (!env.openai.apiKey) return mockReply(input);
  try {
    return await liveReply(input);
  } catch (err) {
    console.warn(`[ai] generateReply OpenAI failed (${errMessage(err)}); using mock fallback`);
    return mockReply(input);
  }
}

async function liveReply(input: ReplyGenerationInput): Promise<ReplyResult> {
  const { review, analysis, project } = input;
  const model = env.openai.model;
  const reviewText = str(review.text);
  const completion = await client().chat.completions.create({
    model,
    // Higher than analysis: we want distinct drafts, not a chorus of the same thank-you.
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: REPLY_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          businessName: project.name ?? undefined,
          replyGuidelines: project.replyGuidelines || undefined,
          reviewText: reviewText || undefined,
          ratingOnly: !reviewText,
          rating: review.rating,
          reviewerName: review.author?.name ?? undefined,
          sentiment: analysis.sentiment,
          suggestedTone: analysis.suggestedTone,
          topics: analysis.topics?.filter(Boolean).slice(0, 5),
          summary: analysis.summary || undefined,
          recentReplies: (input.recentReplies ?? []).filter(Boolean).slice(0, 5),
        }),
      },
    ],
  });
  const parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}") as Record<string, unknown>;
  const body = stripAiTells(str(parsed.body) || mockReply(input).body);
  return { body, model, generatedAt: new Date() };
}

/** Deterministic reply — used when OPENAI_API_KEY is absent, and by tests. */
export function mockReply(input: ReplyGenerationInput): ReplyResult {
  const { review, analysis, project } = input;
  const business = str(project.name) || "our team";
  const name = str(review.author?.name);
  const first = name.split(/\s+/)[0] || "";
  const reviewText = str(review.text);
  const sentiment = analysis.sentiment || sentimentFromRating(review.rating);
  const topic = (analysis.topics ?? []).map(str).find(Boolean) || "";
  const greetings = first
    ? [`Hi ${first},`, `Hello ${first},`, `${first},`]
    : ["Hello,", "Hi there,", "Thanks for writing in."];
  const greeting = greetings[stableIndex(first + review.rating + reviewText, greetings.length)];

  let body: string;
  if (!reviewText) {
    if (sentiment === "positive") {
      body = `${greeting} thanks for the ${review.rating}-star rating. It means a lot to ${business}.`;
    } else if (sentiment === "neutral") {
      body = `${greeting} thanks for the ${review.rating}-star rating. We're always looking for ways to make ${business} better.`;
    } else {
      body = `${greeting} thanks for the rating. Sorry ${business} didn't meet expectations. We'd welcome a chance to make it right.`;
    }
  } else if (sentiment === "positive") {
    const detail = topic ? ` Glad to hear the ${topic} stood out.` : "";
    body =
      `${greeting} really appreciate you taking a moment to share this.${detail} ` +
      `It means a lot to everyone at ${business}.`;
  } else if (sentiment === "neutral") {
    const detail = topic ? ` We'll keep working on ${topic}.` : "";
    body =
      `${greeting} thanks for the honest note.${detail} ` +
      `Feedback like this helps ${business} improve.`;
  } else {
    const detail = topic ? ` We're sorry about the ${topic}.` : "";
    body =
      `${greeting} thanks for telling us, and we're sorry your visit fell short.${detail} ` +
      `Please reach out to ${business} so we can make this right.`;
  }
  return { body: stripAiTells(body), model: "mock", generatedAt: new Date() };
}

// ---- Deterministic helpers (shared by mock + live normalization) ----

function sentimentFromRating(rating: number): string {
  if (rating >= 4) return "positive";
  if (rating === 3) return "neutral";
  return "negative";
}

function normalizeSentiment(value: string, rating: number): string {
  const v = value.toLowerCase();
  if (v === "positive" || v === "neutral" || v === "negative") return v;
  return sentimentFromRating(rating);
}

function deriveTopics(review: ReviewInput): string[] {
  const text = String(review.text ?? "").toLowerCase();
  const topics: string[] = [];
  const keywords: Array<[string, RegExp]> = [
    ["service", /\bservice|staff|team|friendly|rude\b/],
    ["price", /\bprice|cost|expensive|cheap|value|worth\b/],
    ["quality", /\bquality|great|excellent|poor|bad|amazing\b/],
    ["wait time", /\bwait|slow|quick|fast|delay\b/],
    ["cleanliness", /\bclean|dirty|tidy|mess\b/],
  ];
  for (const [topic, re] of keywords) {
    if (re.test(text)) topics.push(topic);
  }
  if (!topics.length) topics.push(sentimentFromRating(review.rating) === "positive" ? "experience" : "concern");
  return topics.slice(0, 5);
}

function defaultSummary(review: ReviewInput, sentiment: string): string {
  return `A ${review.rating}-star, ${sentiment} review from the customer.`;
}

function defaultTone(sentiment: string): string {
  if (sentiment === "positive") return "warm and grateful";
  if (sentiment === "neutral") return "polite and appreciative";
  return "apologetic and solution-focused";
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Models ignore "no em dash" often enough that we strip them after the fact. */
function stripAiTells(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,(?=\S)/g, ", ")
    .replace(/  +/g, " ")
    .trim();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stable 0..n-1 picker so mock variety is deterministic (same input → same draft). */
function stableIndex(seed: string, n: number): number {
  if (n <= 1) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % n;
}
