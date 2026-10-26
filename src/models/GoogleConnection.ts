import { Schema, model, type InferSchemaType, type Types } from "mongoose";

/** The singleton's fixed key — there is exactly one Google connection (the operator's). */
export const GOOGLE_CONNECTION_KEY = "default";

/**
 * The operator's single Google account connection (a Manager on every client's
 * Business Profile). Holds the encrypted refresh token and the pending OAuth
 * `state`. A doc with no `refreshTokenEnc` (e.g. a connect that was started but
 * never completed) counts as "not connected".
 */
const googleConnectionSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: GOOGLE_CONNECTION_KEY },
    // AES-256-GCM `iv:tag:ciphertext` (utils/crypto.ts). Never returned by the API.
    refreshTokenEnc: { type: String },
    email: { type: String },
    scopes: { type: [String], default: undefined },
    connectedAt: { type: Date },
    lastError: { type: String },
    // Single-use CSRF state for the OAuth redirect; cleared on use.
    oauthState: { type: String },
    oauthStateExpiresAt: { type: Date },
  },
  { timestamps: true },
);

googleConnectionSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.refreshTokenEnc;
    delete ret.oauthState;
    delete ret.oauthStateExpiresAt;
    delete ret.__v;
    return ret;
  },
});

export type GoogleConnectionDoc = InferSchemaType<typeof googleConnectionSchema> & { _id: Types.ObjectId };

export const GoogleConnection = model("GoogleConnection", googleConnectionSchema);
