import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID_ENV = process.env.VECTOR_STORE_ID;

function jsonError(msg) { return { ok: false, error: msg }; }

export async function ingest(opts = {}) {
  const skip = Number(opts.skip) || 0;
  const limit = Number(opts.limit) || undefined;

  if (!OPENAI_API_KEY) return jsonError("Falta OPENAI_API_KEY en .env");
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  const ROOT = process.cwd();
  const DOCS_DIR = path.resolve(ROOT, "documentos");
  if (!fs.existsSync(DOCS_DIR)) return jsonError(`No existe la carpeta 'documentos' en: ${DOCS_DIR}`);

  let pdfs = fs.readdirSync(DOCS_DIR).filter(n => /\.pdf$/i.test(n)).sort();
  const total = pdfs.length;
  if (skip) pdfs = pdfs.slice(skip);
  if (limit) pdfs = pdfs.slice(0, limit);
  if (pdfs.length === 0) return { ok: true, info: "Nada para subir en este rango", uploadedCount: 0, totalLocalPDFs: total };

  let vectorStoreId = VECTOR_STORE_ID_ENV;
  if (!vectorStoreId) {
    if (!client?.beta?.vectorStores?.create) return jsonError("SDK sin vectorStores.create y no hay VECTOR_STORE_ID en .env");
    const vs = await client.beta.vectorStores.create({ name: `scc-${Date.now()}` });
    vectorStoreId = vs.id;
  }

  const uploaded = [];
  for (const name of pdfs) {
    const full = path.join(DOCS_DIR, name);
    const file = await client.files.create({ file: fs.createReadStream(full), purpose: "assistants" });

    let vsFile;
    if (client?.beta?.vectorStores?.files?.create) {
      vsFile = await client.beta.vectorStores.files.create({ vector_store_id: vectorStoreId, file_id: file.id });
    } else {
      const res = await fetch(`https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: file.id }),
      });
      if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(`REST attach failed: ${res.status} ${res.statusText} ${txt}`.trim()); }
      vsFile = await res.json();
    }

    uploaded.push({ name, fileId: file.id, vsFileId: vsFile?.id ?? vsFile?.file_id ?? null });
  }

  return { ok: true, vectorStoreId, uploadedCount: uploaded.length, uploaded, totalLocalPDFs: total, range: { skip, limit } };
}
