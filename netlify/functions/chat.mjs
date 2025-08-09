// netlify/functions/chat.mjs (TEST MINIMO)
import OpenAI from "openai";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Use POST" });
    }

    const { OPENAI_API_KEY } = process.env;
    if (!OPENAI_API_KEY) return json(500, { error: "Falta OPENAI_API_KEY" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "JSON inválido" }); }

    const message = (body.message || "").toString().trim();
    if (!message) return json(400, { error: "Falta 'message'" });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const response = await client.responses.create({
      model: "gpt-4o-mini",      // si falla este modelo, te aviso cómo cambiarlo
      input: [
        { role: "system", content: "Eres un asistente breve y claro."},
        { role: "user", content: message }
      ]
    });

    const text =
      response.output?.[0]?.content?.[0]?.text?.value ??
      response.output_text ??
      "Sin respuesta";

    return json(200, { text });
  } catch (err) {
    console.error("chat TEST error:", err?.response?.data || err);
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
