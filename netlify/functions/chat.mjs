// netlify/functions/chat.mjs
import OpenAI from "openai";

const MODEL_PRIMARY = "gpt-4o-mini";
const MODEL_FALLBACK = "gpt-4o";

const systemPrompt = `Sos Operabot SCC. Respondé usando los instructivos (PDFs) cuando sea posible.
- Si hay respuesta en los PDFs, citá los archivos relevantes (solo nombre).
- Si hay contradicciones entre PDFs, marcálo y sugerí cómo resolver.
- Si no está en los PDFs, respondé con criterio y aclaración: "(criterio / no hallado en instructivos)".
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
function extract(resp) {
  // 1) intento directo (forma canónica de Responses)
  let text = (resp?.output_text ?? "").toString().trim();

  // 2) si no vino output_text, recorrer todas las partes de output
  if (!text && Array.isArray(resp?.output)) {
    const chunks = [];
    for (const item of resp.output) {
      const parts = Array.isArray(item?.content) ? item.content : [];
      for (const p of parts) {
        const maybe =
          p?.text?.value ?? // part.type === "output_text"
          p?.text ??         // algunos SDKs devuelven .text plano
          "";
        if (maybe) chunks.push(String(maybe));
      }
    }
    text = chunks.join("\n").trim();
  }

  // 3) extraer citas (annotations) si existen en cualquiera de las partes
  const citations = [];
  try {
    for (const item of resp?.output || []) {
      for (const p of item?.content || []) {
        const anns = p?.text?.annotations || p?.annotations || [];
        for (const ann of anns) {
          const fc = ann?.file_citation || ann?.citation;
          if (fc?.file_id) {
            citations.push({
              filename: fc?.filename || fc?.file_name || `file:${fc.file_id}`,
              preview: ann?.quote || fc?.quote || "",
            });
          }
        }
      }
    }
  } catch {
    // no-op
  }

  return { text: text || "Sin texto.", citations };
}

export async function handler(event) {
  const debug = !!process.env.DEBUG;

  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

    const { OPENAI_API_KEY, VECTOR_STORE_ID } = process.env;
    if (!OPENAI_API_KEY) return json(500, { error: "Falta OPENAI_API_KEY" });

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "JSON inválido" });
    }

    const message = (body.message || "").toString().trim();
    if (!message) return json(400, { error: "Falta 'message'" });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const callResponses = async (model, withFileSearch) => {
      const payload = {
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        temperature: 0.2,
        max_output_tokens: 400,
      };

      if (withFileSearch && VECTOR_STORE_ID) {
        payload.tools = [{ type: "file_search" }];
        payload.tool_resources = { file_search: { vector_store_ids: [VECTOR_STORE_ID] } };
      }

      const resp = await client.responses.create(payload);
      return resp;
    };

    // --- 1) Intento con File Search (RAG) ---
    try {
      const resp1 = await callResponses(MODEL_PRIMARY, true);
      const out = extract(resp1);
      return json(200, {
        ...out,
        usedFileSearch: true,
        model: resp1.model,
        usage: resp1.usage,
      });
    } catch (e1) {
      // Si el endpoint/modelo no acepta file_search/tool_resources → fallback sin RAG
      const msg = (e1?.message || "").toLowerCase();
      const code = (e1?.error?.code || e1?.code || "").toLowerCase();
      const invalidFS =
        msg.includes("unknown parameter: 'tool_resources'") ||
        msg.includes("invalid value: 'file_search'") ||
        msg.includes("unrecognized tool") ||
        msg.includes("tool 'file_search' is not enabled") ||
        code === "unknown_parameter" ||
        code === "invalid_value";

      if (!invalidFS) throw e1;

      // --- 2) Sin File Search (fallback) ---
      try {
        let resp2;
        try {
          resp2 = await callResponses(MODEL_PRIMARY, false);
        } catch (e2) {
          const notFound =
            /model not found/i.test(e2?.message || "") ||
            (e2?.code || e2?.error?.code) === "model_not_found";
          if (notFound) resp2 = await callResponses(MODEL_FALLBACK, false);
          else throw e2;
        }
        const out = extract(resp2);
        return json(200, {
          ...out,
          usedFileSearch: false,
          notice: "File Search no disponible en tu endpoint/API. Respuesta sin PDFs.",
          model: resp2.model,
          usage: resp2.usage,
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
