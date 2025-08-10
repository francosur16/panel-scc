// netlify/functions/chat.mjs

const MODEL_PRIMARY = "gpt-4o-mini";
const MODEL_FALLBACK = "gpt-4o";

export async function handler(event) {
  const debug = !!process.env.DEBUG;

  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Use POST" });
    }

    const { OPENAI_API_KEY, VECTOR_STORE_ID } = process.env;
    if (!OPENAI_API_KEY) return json(500, { error: "Falta OPENAI_API_KEY" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "JSON inválido" }); }

    const message = (body.message || "").toString().trim();
    if (!message) return json(400, { error: "Falta 'message'" });

    const systemPrompt =
`Eres Operabot SCC. Responde usando los instructivos adjuntos (PDFs) cuando puedas.
- Si hay respuesta en los PDFs, cita los archivos relevantes (solo nombre).
- Si detectas contradicciones entre PDFs, dilo y sugiere cómo resolver.
- Si no está en los PDFs, responde con criterio y aclara "(criterio / no hallado en instructivos)".
- Responde breve y práctico.`;

    // --- helpers ---
    const callResponses = async (model, withFileSearch) => {
      const headers = {
        "authorization": `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
        // intentamos con etiquetas beta por compatibilidad en algunas cuentas
        "OpenAI-Beta": "assistants=v2, responses-2024-12-17"
      };

      const payload = {
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        temperature: 0.2
      };

      if (withFileSearch && VECTOR_STORE_ID) {
        payload.tools = [{ type: "file_search" }];
        payload.tool_resources = { file_search: { vector_store_ids: [VECTOR_STORE_ID] } };
      }

      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
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

    const extract = (resp) => {
      const text =
        resp.output_text ||
        resp.output?.[0]?.content?.[0]?.text?.value ||
        "Sin respuesta.";

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
      return { text, citations };
    };

    // --- intento 1: con File Search ---
    try {
      const resp1 = await callResponses(MODEL_PRIMARY, true);
      return json(200, { ...extract(resp1), usedFileSearch: true });
    } catch (e1) {
      // si es rechazo por parámetros de file_search/tool_resources, probamos sin File Search
      const msg = (e1?.message || "").toLowerCase();
      const code = (e1?.code || "").toLowerCase();
      const invalidFS =
        msg.includes("unknown parameter: 'tool_resources'") ||
        msg.includes("invalid value: 'file_search'") ||
        code === "unknown_parameter" ||
        code === "invalid_value";

      if (!invalidFS) throw e1;

      // --- intento 2: sin File Search (fallback) ---
      try {
        let resp2;
        try {
          resp2 = await callResponses(MODEL_PRIMARY, false);
        } catch (e2) {
          if (isModelNotFound(e2)) {
            resp2 = await callResponses(MODEL_FALLBACK, false);
          } else throw e2;
        }

        const out = extract(resp2);
        out.usedFileSearch = false;
        out.notice = "File Search no disponible en tu endpoint/API. Respuesta sin PDFs.";
        return json(200, out);
      } catch (e2) {
        throw e2;
      }
    }
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
    },
    body: JSON.stringify(obj),
  };
}

function isModelNotFound(e) {
  const msg = e?.message || "";
  const code = e?.code || e?.data?.error?.code;
  return /model not found/i.test(msg) || code === "model_not_found";
}
