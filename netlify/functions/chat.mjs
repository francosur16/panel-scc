// netlify/functions/chat.mjs
const MODEL_PRIMARY = "gpt-4o-mini";
const MODEL_FALLBACK = "gpt-4o"; // por si el primary no está disponible

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

    const systemPrompt =
`Eres Operabot SCC. Responde usando los instructivos adjuntos (PDFs).
- Si hay respuesta en los PDFs, cita los archivos relevantes (solo nombre).
- Si detectas contradicciones entre PDFs, dilo y sugiere cómo resolver.
- Si no está en los PDFs, responde con criterio y aclara "(criterio / no hallado en instructivos)".
- Responde breve y práctico.`;

    const makeReq = async (model) => {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${OPENAI_API_KEY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message }
          ],
          tools: [{ type: "file_search" }],
          tool_resources: { file_search: { vector_store_ids: [VECTOR_STORE_ID] } },
          temperature: 0.2
          // max_output_tokens: 500, // opcional
        })
      });

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (!r.ok) {
        const err = new Error(`${r.status} ${data?.error?.message || "API error"}`);
        err.status = r.status;
        err.code = data?.error?.code;
        err.data = data;
        throw err;
      }
      return data;
    };

    // intento con primary y fallback si hace falta
    let resp;
    try {
      resp = await makeReq(MODEL_PRIMARY);
    } catch (e) {
      if (isModelNotFound(e)) {
        resp = await makeReq(MODEL_FALLBACK);
      } else {
        throw e;
      }
    }

    const text =
      resp.output_text ||
      resp.output?.[0]?.content?.[0]?.text?.value ||
      "Sin respuesta.";

    // citas si vinieran
    const annotations = resp.output?.[0]?.content?.[0]?.text?.annotations || [];
    const citations = [];
    for (const ann of annotations) {
      const fc = ann?.file_citation;
      if (fc?.file_id) {
        citations.push({
          filename: fc?.filename || `file:${fc.file_id}`,
          preview: ann?.quote || ""
        });
      }
    }

    return json(200, { text, citations });
  } catch (err) {
    const safe = {
      message: err?.message || String(err),
      status: err?.status,
      code: err?.code,
      data: err?.data
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
      "OpenAI-Beta": "assistants=v2",

    },
    body: JSON.stringify(obj),
  };
}

function isModelNotFound(e) {
  const msg = e?.message || "";
  const code = e?.code || e?.data?.error?.code;
  return /model not found/i.test(msg) || code === "model_not_found";
}
