import { MongoClient } from "mongodb";
import { config } from "../config.js";

let connecting = null;
let db = null;

export async function getDb() {
  if (db) return db;
  if (!config.mongoUri) {
    throw Object.assign(new Error("Add MONGODB_URI in backend/.env"), { status: 503 });
  }
  if (!connecting) {
    connecting = (async () => {
      const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 4000 });
      await client.connect();
      const database = client.db();
      const reports = database.collection("reports");
      await reports.createIndexes([
        { key: { id: 1 }, unique: true },
        { key: { mcNumber: 1, createdAt: -1 } },
        { key: { dotNumber: 1, createdAt: -1 } },
      ]);
      await database.collection("users").createIndexes([{ key: { email: 1 }, unique: true }]);
      await database.collection("sessions").createIndexes([
        { key: { tokenHash: 1 }, unique: true },
        { key: { userId: 1 } },
      ]);
      await database.collection("usage").createIndexes([{ key: { userId: 1, date: 1 }, unique: true }]);
      await database.collection("email_accounts").createIndexes([
        { key: { userId: 1, email: 1 }, unique: true },
        { key: { userId: 1, isDefault: 1 } },
      ]);
      await database.collection("email_templates").createIndexes([{ key: { userId: 1, name: 1 }, unique: true }]);
      await database.collection("email_sent").createIndexes([{ key: { userId: 1, createdAt: -1 } }]);
      db = database;
      return database;
    })().catch((error) => {
      connecting = null;
      throw Object.assign(new Error(`MongoDB is not reachable at the local URI (${error.message})`), {
        status: 503,
      });
    });
  }
  return connecting;
}

export async function reportsCollection() {
  const database = await getDb();
  return database.collection("reports");
}

export async function pingMongo() {
  try {
    const database = await getDb();
    await database.command({ ping: 1 });
    return { ok: true, name: database.databaseName };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
