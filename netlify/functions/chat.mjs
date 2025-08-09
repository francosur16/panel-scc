// netlify/functions/chat.mjs
import OpenAI from "openai";

const MODEL_PRIMARY = "gpt-4o-mini";
const MODEL_FALLBACK = "gpt-4o"; // fallback si el mini no está disponible

export async function handler(event) {
  const debug = !!process.env.DEBUG;

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

    const run = async (model) => client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      // 👇 habilita File Search y conecta tu vector store
      tools: [{ type: "file_search" }],
      tool_choice: "auto",
      tool_resources: {
        file_search: { vector_store_ids: [VECTOR_STORE_ID] }
      },
      // Opcional para acotar costos:
      // max_tokens: 500,
      temperature: 0.2
    });

    const resp = await withRetries(async () => {
      try {
        return await run(MODEL_PRIMARY);
      } catch (e) {
        if (isModelNotFound(e)) return await run(MODEL_FALLBACK);
        throw e;
      }
    });

    const choice = resp.choices?.[0];
    const msg = choice?.message;

    // Texto de salida
    let text = "Sin respuesta.";
    if (msg?.content) {
      // content puede ser string o array de bloques
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content) && msg.content.length) {
        const first = msg.content.find(p => p.type === "text") || msg.content[0];
        text = first?.text || first?.content || JSON.stringify(first);
      }
    }

    // Intento de extraer anotaciones/citas (si el modelo las devuelve)
    const annotations =
      (Array.isArray(msg?.content)
        ? (msg.content.find(p => p.type === "text")?.annotations || [])
        : (msg?.annotations || [])) || [];

    const citations = [];
    if (Array.isArray(annotations)) {
      for (const ann of annotations) {
        const fc = ann?.file_citation;
        if (fc?.file_id) {
          try {
            const file = await client.files.retrieve(fc.file_id);
            citations.push({
              filename: file?.filename || `file:${fc.file_id}`,
              preview: ann?.quote || ""
            });
          } catch {
            citations.push({ filename: `file:${fc.file_id}`, preview: ann?.quote || "" });
          }
        }
      }
    }

    return json(200, { text, citations });
  } catch (err) {
    const safe = {
      message: err?.message || String(err),
      status: err?.status || err?.response?.status,
      code: err?.code,
      type: err?.type,
      data: err?.response?.data
    };
    console.error("chat error:", safe);

    if (debug) return json(500, { error: "Fallo interno (debug)", detail: safe });

    if (safe.code === "insufficient_quota") {
      return json(402, { error: "Sin crédito en OpenAI API. Revisá Billing." });
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
      const retriable = status === 429 ||  status === 503;
      if (!retriable || i === tries - 1) throw err;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}
