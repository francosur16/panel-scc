import OpenAI from "openai";
import fs from "fs";
import path from "path";
import process from "process";

(async () => {
  try {
    console.log("[upload] Iniciando…");

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
    console.log("[upload] OPENAI_API_KEY presente (longitud)", OPENAI_API_KEY.length);

    const folder = process.argv[2] || "./pdfs";
    const filesAll = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    const files = filesAll.filter(f => f.toLowerCase().endsWith(".pdf"));
    console.log("[upload] Carpeta:", folder, "PDFs encontrados:", files.length);

    if (!files.length) throw new Error("No encontré PDFs en " + folder);

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    console.log("[upload] Creando vector store…");
    const vs = await client.vectorStores.create({ name: "operabot-pdfs" });
    console.log("[upload] VECTOR_STORE_ID:", vs.id);

    console.log("[upload] Subiendo PDFs…", files);
    const streams = files.map(f => fs.createReadStream(path.join(folder, f)));

    const batch = await client.vectorStores.fileBatches.uploadAndPoll(vs.id, { files: streams });

    console.log("[upload] Estado:", batch.status);
    console.log("[upload] Conteo:", batch.file_counts);
    console.log("VECTOR_STORE_ID:", vs.id);
    console.log("[upload] Listo ✅");
  } catch (e) {
    console.error("[upload] ERROR:", e?.message || e);
    console.error(e?.stack || "");
    process.exit(1);
  }
})();