// netlify/functions/chat.mjs
import OpenAI from "openai";

const MODEL_PRIMARY = "gpt-4o-mini";
const MODEL_FALLBACK = "gpt-4o";
const POLL_INTERVAL_MS = 700;
const POLL_TIMEOUT_MS = 60000; // 60s

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

// --- extraer texto + citas de un mensaje de Assistants ---
function extractFromAssistantMessage(msg) {
  // Texto
  let text = "";
  for (const part of msg?.content || []) {
    if (part.type === "text" && part.text?.value) {
      text += (text ? "\n" : "") + part.text.value;
    }
  }

  // Citas (annotations)
  const citations = [];
  for (const part of msg?.content || []) {
    if (part.type !== "text") continue;
    const anns = part.text?.annotations || [];
    for (const ann of anns) {
      const fc = ann?.file_citation;
      if (fc?.file_id) {
        citations.push({
          filename: fc?.filename || `file:${fc.file_id}`,
          preview: ann?.quote || "",
        });
      }
    }
  }
  return { text: text.trim() || "Sin texto.", citations };
}

// --- fallback: Responses API SIN RAG ---
async function plainResponsesFallback(client, message) {
  const payload = {
    model: MODEL_PRIMARY,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    temperature: 0.2,
    max_output_tokens: 400,
  };
  try {
    const resp = await client.responses.create(payload);
    // parser robusto
    let text = (resp.output_text ?? "").toString().trim();
    if (!text && Array.isArray(resp.output)) {
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
    return {
      ok: true,
      usedFileSearch: false,
      notice: "File Search no disponible en tu endpoint/API (se respondió sin PDFs).",
      model: resp.model,
      usage: resp.usage,
      text: text || "(sin texto)",
      citations: [],
    };
  } catch (e2) {
    // Fallback a modelo alternativo si hiciera falta
    if (/model not found/i.test(e2?.message || "") || (e2?.code || e2?.error?.code) === "model_not_found") {
      const resp2 = await client.responses.create({ ...payload, model: MODEL_FALLBACK });
      const text2 = resp2.output_text?.trim() || "(sin texto)";
      return {
        ok: true,
        usedFileSearch: false,
        notice: "File Search no disponible en tu endpoint/API (se respondió sin PDFs).",
        model: resp2.model,
        usage: resp2.usage,
        text: text2,
        citations: [],
      };
    }
    throw e2;
  }
}

export async function handler(event) {
  const debug = !!process.env.DEBUG;
  if (event.httpMethod === "OPTIONS") return json(204, {});
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

    const { OPENAI_API_KEY, VECTOR_STORE_ID, ASSISTANT_ID } = process.env;
    if (!OPENAI_API_KEY) return json(500, { error: "Falta OPENAI_API_KEY" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "JSON inválido" }); }
    const message = (body.message || "").toString().trim();
    if (!message) return json(400, { error: "Falta 'message'" });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    // --- 1) Intento con Assistants v2 + file_search ---
    try {
      // a) Crear (o reutilizar) un assistant con file_search
      let assistantId = ASSISTANT_ID;
      if (!assistantId) {
        const asst = await client.assistants.create({
          name: "Operabot SCC",
          model: MODEL_PRIMARY,
          instructions: systemPrompt,
          tools: [{ type: "file_search" }],
          // Adjuntamos el vector store a nivel assistant si está disponible
          ...(VECTOR_STORE_ID ? { tool_resources: { file_search: { vector_store_ids: [VECTOR_STORE_ID] } } } : {}),
          // El SDK maneja los headers beta internamente
        });
        assistantId = asst.id;
      }

      // b) Crear thread con el mensaje del usuario
      const thread = await client.threads.create({
        messages: [{ role: "user", content: message }],
      });

      // c) Correr el assistant (extra: reforzamos vector store también en el run por si el assistant no lo tenía)
      const run = await client.threads.runs.create(thread.id, {
        assistant_id: assistantId,
        ...(VECTOR_STORE_ID ? { tool_resources: { file_search: { vector_store_ids: [VECTOR_STORE_ID] } } } : {}),
      });

      // d) Polling hasta completar
      const t0 = Date.now();
      let runStatus = run;
      while (!["completed", "failed", "cancelled", "expired"].includes(runStatus.status)) {
        if (Date.now() - t0 > POLL_TIMEOUT_MS) throw new Error("Run timeout");
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        runStatus = await client.threads.runs.retrieve(thread.id, run.id);
      }
      if (runStatus.status !== "completed") {
        throw new Error(`Run ${runStatus.status}`);
      }

      // e) Recuperar el último mensaje del assistant
      const msgs = await client.threads.messages.list(thread.id, { limit: 5 });
      const assistantMsg = (msgs.data || []).find(m => m.role === "assistant") || msgs.data?.[0];
      const { text, citations } = extractFromAssistantMessage(assistantMsg);

      return json(200, {
        text,
        citations,
        usedFileSearch: true,
        model: MODEL_PRIMARY,
        usage: undefined, // opcional, podríamos sumar usage leyendo run.metrics cuando esté disponible
      });
    } catch (e1) {
      // --- 2) Fallback sin RAG (Responses API) ---
      const out = await plainResponsesFallback(client, message);
      if (debug) out.rag_error = {
        status: e1?.status,
        code: e1?.code || e1?.error?.code,
        message: e1?.message,
        data: e1?.data || e1?.error,
      };
      return json(200, out);
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

