import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod: MongoMemoryServer | undefined;

/** Starts a standalone in-memory MongoDB and connects mongoose. */
export async function connectMemoryMongo(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
  await mongoose.connect(mongod.getUri());
  // Build indexes (idempotency partial-unique, etc.) so tests exercise them.
  await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).init()));
}

export async function disconnectMemoryMongo(): Promise<void> {
  await mongoose.disconnect().catch(() => undefined);
  await mongod?.stop();
  mongod = undefined;
}

export async function clearDatabase(): Promise<void> {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}
