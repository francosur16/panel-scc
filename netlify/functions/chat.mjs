// netlify/functions/chat.mjs
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const VS_ID  = process.env.VECTOR_STORE_ID || "";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { message } = JSON.parse(event.body || "{}");
    if (!message) {
      return json({ ok: false, error: "Falta 'message'." }, 400);
    }

    // Assistant Responses API + File Search en tu Vector Store
    const resp = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "Sos Operabot SCC. Respondé SOLO con info de los PDF; si no está, decí brevemente que no está en instructivos. Evitá inventar.",
        },
        { role: "user", content: message },
      ],
      tools: [{ type: "file_search" }],
      tool_choice: "auto",
      tool_resources: VS_ID ? { file_search: { vector_store_ids: [VS_ID] } } : undefined,
    });

    // Texto final
    const text = (resp.output_text || "").trim();

    // Juntar file_ids citados (según anotaciones)
    const fileIds = new Set();
    for (const item of resp.output || []) {
      if (item.type !== "message") continue;
      for (const c of item.content || []) {
        const ann = c?.annotations || [];
        for (const a of ann) {
          const id =
            a?.file_citation?.file_id ||
            a?.file_path?.file_id ||
            a?.image_url?.file_id;
          if (id) fileIds.add(id);
        }
      }
    }

    // Resolver filenames
    const citations = [];
    for (const id of fileIds) {
      try {
        const f = await client.files.retrieve(id);
        citations.push({ file_id: id, filename: f?.filename || id });
      } catch {
        citations.push({ file_id: id, filename: id });
      }
    }

    return json({
      ok: true,
      usedFileSearch: citations.length > 0,
      model: resp.model,
      text,
      citations,
    });
  } catch (err) {
    return json(
      { ok: false, error: err?.message || String(err) },
      500
    );
  }
}

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}