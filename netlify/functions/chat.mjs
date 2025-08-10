// netlify/functions/chat.mjs
import OpenAI from "openai";

const MODEL_PRIMARY = "gpt-4o-mini";
const MODEL_FALLBACK = "gpt-4o";

const systemPrompt = `Sos Operabot SCC. Respondé usando los instructivos (PDFs) cuando sea posible.
- Si hay respuesta en los PDFs, citá los archivos relevantes (solo nombre).
- Si hay contradicciones entre PDFs, marcálo y sugerí cómo resolver.
- Si no está en los PDFs, respondé con la mejor práctica y aclaración: "(criterio / no hallado en instructivos)".
- Respondé breve y práctico.`;

const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
  },
  body: JSON.stringify(obj),
});

// ---- Parser robusto para Responses API ----
function extract(resp, fileNameById = new Map()) {
  let text = (resp?.output_text ?? "").toString().trim();

  if (!text && Array.isArray(resp?.output)) {
    const chunks = [];
    for (const item of resp.output) {
      const parts = Array.isArray(item?.content) ? item.content : [];
      for (const p of parts) {
        const maybe = p?.text?.value ?? p?.text ?? "";
        if (maybe) chunks.push(String(maybe));
      }
    }
    text = chunks.join("\n").trim();
  }

  const citations = [];
  try {
    for (const item of resp?.output || []) {
      for (const p of item?.content || []) {
        const anns = p?.text?.annotations || p?.annotations || [];
        for (const ann of anns) {
          const fc = ann?.file_citation || ann?.citation;
          if (fc?.file_id) {
            const fid = fc.file_id;
            const friendly = fc?.filename || fc?.file_name || fileNameById.get(fid);
            citations.push({
              filename: friendly || `file:${fid}`,
              preview: ann?.quote || fc?.quote || "",
            });
          }
        }
      }
    }
  } catch {}

  return { text: text || "Sin texto.", citations };
}

export async function handler(event) {
  const debug = !!process.env.DEBUG;

  if (event.httpMethod === "OPTIONS") return json(204, {});
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

    const { OPENAI_API_KEY, VECTOR_STORE_ID } = process.env;
    if (!OPENAI_API_KEY) return json(500, { error: "Falta OPENAI_API_KEY" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "JSON inválido" }); }

    const message = (body.message || "").toString().trim();
    if (!message) return json(400, { error: "Falta 'message'" });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Listamos algunos files del vector store para adjuntarlos (sin usar tool_resources)
    async function listVectorFiles(limit = 20) {
      const fileNameById = new Map();
      const fileIds = [];
      try {
        let cursor;
        do {
          const page = await client.vectorStores.files.list(VECTOR_STORE_ID, { limit: 20, after: cursor });
          for (const f of page.data || []) {
            fileIds.push(f.id);
            // intentamos recuperar metadatos legibles (nombre)
            if (f?.id && f?.created_at) {
              // opcionalmente podríamos pedir /files/:id, pero muchas veces viene filename en annotations
            }
          }
          cursor = page?.last_id || null;
        } while (fileIds.length < limit && cursor);

        // Intentamos mapear id->nombre consultando /files si hace falta
        // (no es obligatorio; las citas suelen traer filename)
        // Para no excedernos, lo hacemos mejor-on-demand cuando falte.
        return { fileIds: fileIds.slice(0, limit), fileNameById };
      } catch (e) {
        if (debug) console.error("listVectorFiles error:", e?.message || e);
        return { fileIds: [], fileNameById };
      }
    }

    // Llamado a Responses API. Si withFileSearch=true, usamos attachments + header beta (sin tool_resources)
    const callResponses = async (model, withFileSearch) => {
      const payload = {
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        temperature: 0.2,
        max_output_tokens: 500,
        tools: withFileSearch ? [{ type: "file_search" }] : undefined,
      };

      let fileNameById = new Map();

      if (withFileSearch && VECTOR_STORE_ID) {
        const { fileIds, fileNameById: map } = await listVectorFiles(20);
        fileNameById = map;
        if (fileIds.length) {
          payload.attachments = fileIds.map(fid => ({
            file_id: fid,
            tools: [{ type: "file_search" }],
          }));
        }
      }

      const headers = {
        "authorization": `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
      };
      if (withFileSearch) {
        headers["OpenAI-Beta"] = "assistants=v2";
      }

      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { raw }; }

      if (!r.ok) {
        const err = new Error(`${r.status} ${data?.error?.message || "API error"}`);
        err.status = r.status;
        err.code = data?.error?.code;
        err.data = data;
        throw err;
      }
      return { data, fileNameById };
    };

    // --- 1) Intento con File Search (attachments) ---
    try {
      const { data: resp1, fileNameById } = await callResponses(MODEL_PRIMARY, true);
      const out = extract(resp1, fileNameById);
      return json(200, {
        ...out,
        usedFileSearch: true,
        model: resp1.model,
        usage: resp1.usage,
      });
    } catch (e1) {
      // Si el tool no está habilitado en tu endpoint/modelo → fallback sin RAG
      const msg = (e1?.message || "").toLowerCase();
      const code = (e1?.code || "").toLowerCase();
      const fsUnsupported =
        msg.includes("unrecognized tool") ||
        msg.includes("tool 'file_search' is not enabled") ||
        code === "unknown_parameter" ||
        code === "invalid_value" ||
        code === "permission_denied" ||
        code === "not_found";

      if (!fsUnsupported) {
        // errores de red u otros: sigo mostrando fallback igual para no romper UX
        if (debug) console.error("FileSearch error (no categorizado):", e1);
      }

      // --- 2) Sin File Search (fallback) ---
      try {
        let resp2;
        try {
          const { data } = await callResponses(MODEL_PRIMARY, false);
          resp2 = data;
        } catch (e2) {
          const notFound =
            /model not found/i.test(e2?.message || "") ||
            (e2?.code || e2?.error?.code) === "model_not_found";
          if (notFound) {
            const { data } = await callResponses(MODEL_FALLBACK, false);
            resp2 = data;
          } else throw e2;
        }
        const out = extract(resp2);
        const extra = debug ? { rag_error: { status: e1.status, code: e1.code, message: e1.message, data: e1.data } } : {};
        return json(200, {
          ...out,
          usedFileSearch: false,
          notice: "File Search no disponible en tu endpoint/API (se respondió sin PDFs).",
          model: resp2.model,
          usage: resp2.usage,
          ...extra
        });
      } catch (e2) {
        throw e2;
      }
    }
  } catch (err) {
    const safe = {
      message: err?.message || String(err),
      status: err?.status,
      code: err?.code || err?.error?.code,
      data: err?.data || err?.error,
    };
    console.error("chat error:", safe);
    if (process.env.DEBUG) return json(500, { error: "Fallo interno (debug)", detail: safe });
    if (safe.code === "insufficient_quota") return json(402, { error: "Sin crédito en OpenAI API. Revisá Billing." });
    if (safe.status === 401) return json(401, { error: "API key inválida o sin permisos." });
    return json(500, { error: "Fallo interno" });
  }
}
