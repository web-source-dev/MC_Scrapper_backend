import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportsCollection } from "../lib/mongo.js";

export const REVIEW_KINDS = ["review", "report"];
export const REPORT_WORDS = [
  "No-show",
  "Unreachable",
  "Double broker",
  "Late",
  "Wrong equipment",
  "No tracking",
  "Failed to complete",
  "Unprofessional",
  "Detention",
  "Misrepresented",
];

const TAG_IDS = new Set(REPORT_WORDS);
const MAX_NOTE = 2000;
const MAX_NAME = 40;
const MAX_PER_CARRIER = 200;
const legacyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/reviews.json");

let migrated = false;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanText(value, max, field) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (field === "note" && !text) {
    throw httpError("Write the report before publishing");
  }
  if (text.length > max) {
    throw httpError(`${field === "note" ? "Note" : "Name"} is too long`);
  }
  return text || null;
}

function toClient(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return {
    ...rest,
    createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
  };
}

function carrierFilter(mcNumber, dotNumber) {
  if (mcNumber && dotNumber) {
    return { $or: [{ mcNumber }, { dotNumber }] };
  }
  if (mcNumber) return { mcNumber };
  return { dotNumber };
}

async function migrateLegacyFile(collection) {
  if (migrated) return;
  migrated = true;
  try {
    const raw = await readFile(legacyPath, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if (!items.length) return;
    await collection.insertMany(
      items.map((item) => ({
        ...item,
        createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
        published: true,
      })),
      { ordered: false },
    );
  } catch (error) {
    if (error.code === "ENOENT" || error.code === 11000 || error.writeErrors) return;
    console.warn("Could not import backend/data/reviews.json:", error.message);
  }
}

async function collection() {
  const reports = await reportsCollection();
  await migrateLegacyFile(reports);
  return reports;
}

export async function listReviews(mcNumber, dotNumber) {
  if (!mcNumber && !dotNumber) {
    throw httpError("Provide an MC or USDOT number");
  }
  const reports = await collection();
  const items = await reports.find(carrierFilter(mcNumber, dotNumber)).sort({ createdAt: -1 }).toArray();
  return items.map(toClient);
}

export async function addReview(input = {}) {
  const mcNumber = Number.parseInt(String(input.mcNumber ?? "").replace(/\D/g, ""), 10) || null;
  const dotNumber = Number.parseInt(String(input.dotNumber ?? "").replace(/\D/g, ""), 10) || null;
  if (!mcNumber && !dotNumber) {
    throw httpError("Provide an MC or USDOT number");
  }

  const kind = REVIEW_KINDS.includes(input.kind) ? input.kind : "report";
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.filter((id) => TAG_IDS.has(id)))] : [];
  const note = cleanText(input.note, MAX_NOTE, "note");
  const dispatcher = cleanText(input.dispatcher, MAX_NAME, "name");

  const reports = await collection();
  const existing = await reports.countDocuments(carrierFilter(mcNumber, dotNumber));
  if (existing >= MAX_PER_CARRIER) {
    throw httpError("This MC already has the maximum number of reports");
  }

  const item = {
    id: randomUUID(),
    mcNumber,
    mcDisplay: input.mcDisplay || (mcNumber ? `MC-${mcNumber}` : null),
    dotNumber,
    legalName: input.legalName || null,
    kind,
    tags,
    note,
    dispatcher,
    createdAt: new Date(),
    published: true,
  };
  await reports.insertOne(item);
  return toClient(item);
}
