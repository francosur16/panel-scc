// netlify/functions/chat.mjs
import OpenAI from "openai";

const MODEL_PRIMARY = "gpt-4o-mini";
const MODEL_FALLBACK = "gpt-4.1-mini"; // intenta este si el primario no está disponible

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Use POST" });
    }

    const { OPENAI_API_KEY, VECTOR_STORE_ID } = process.env;
    if (!OPENAI_API_KEY) return json(500, { error: "Falta OPENAI_API_KEY" });
    if (!VECTOR_STORE_ID) return json(500, { error: "Falta VECTOR_STORE_ID" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "JSON inválido" }); }

    const message = (body.message || "").toString().trim();
    if (!message) return json(400, { error: "Falta 'message'" });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const systemPrompt =
`Eres Operabot SCC. Responde usando los instructivos adjuntos (PDFs).
- Si hay respuesta en los PDFs, cita los archivos relevantes (solo nombre).
- Si detectas contradicciones entre PDFs, dilo y sugiere cómo resolver.
- Si no está en los PDFs, responde con criterio y aclara "(criterio / no hallado en instructivos)".
- Responde breve y práctico.`;

    const run = async (model) => client.responses.create({
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      attachments: [{ vector_store_id: VECTOR_STORE_ID }],
      // opcional: límite para controlar costos de salida
      // max_output_tokens: 500,
    });

    // Reintentos con backoff para 429/503, con fallback de modelo
    const resp = await withRetries(async () => {
      try {
        return await run(MODEL_PRIMARY);
      } catch (e) {
        if (isModelNotFound(e)) return await run(MODEL_FALLBACK);
        throw e;
      }
    });

    const text =
      resp.output?.[0]?.content?.[0]?.text?.value ??
      resp.output_text ??
      "Sin respuesta.";

    // Extraer citas si vienen anotaciones
    const annotations = resp.output?.[0]?.content?.[0]?.text?.annotations ?? [];
    const citations = [];
    for (const ann of annotations) {
      const fc = ann?.file_citation;
      if (fc?.file_id) {
        try {
          const file = await client.files.retrieve(fc.file_id);
          citations.push({ filename: file?.filename || `file:${fc.file_id}`, preview: ann?.quote || "" });
        } catch {
          citations.push({ filename: `file:${fc.file_id}`, preview: ann?.quote || "" });
        }
      }
    }

    return json(200, { text, citations });
  } catch (err) {
    const safe = {
      message: err?.message || String(err),
      status: err?.status || err?.response?.status,
      code: err?.code,
      type: err?.type
    };
    console.error("chat error:", safe, err?.response?.data || "");
    if (safe.code === "insufficient_quota") {
      return json(402, { error: "Sin crédito en OpenAI API. Revisá Billing en platform.openai.com." });
    }
    if (safe.status === 401) {
      return json(401, { error: "API key inválida o sin permisos." });
    }
    return json(500, { error: "Fallo interno" });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

// Helpers -----------------------------

function isModelNotFound(err) {
  return (
    err?.code === "model_not_found" ||
    err?.response?.data?.error?.code === "model_not_found" ||
    /model not found/i.test(err?.message || "")
  );
}

async function withRetries(fn, { tries = 3, baseMs = 600 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const retriable = status === 429 || status === 503;
      if (!retriable || i === tries - 1) throw err;
      await delay(baseMs * Math.pow(2, i)); // 600ms, 1200ms, 2400ms
    }
  }
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}
