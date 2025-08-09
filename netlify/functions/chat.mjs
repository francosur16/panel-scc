import OpenAI from "openai";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Use POST" }) };
    }

    const { message, history = [] } = JSON.parse(event.body || "{}");
    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: "Falta 'message'" }) };
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const systemInstructions = `
Eres Operabot SCC. Prioriza información de los PDFs (file_search) y cita [archivo.pdf].
Si hay contradicciones entre pasajes, indícalo como "Posible incoherencia" y propone resolución citando ambos.
Si no encuentras en PDFs, responde con criterio y añade "(respuesta basada en criterio, no hallada en instructivos)".
Sé práctico y claro (bullets cuando ayude).
`;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [...history, { role: "user", content: message }],
      instructions: systemInstructions,
      tools: [{ type: "file_search", vector_store_ids: [process.env.VECTOR_STORE_ID] }],
      include: ["output_text", "output[*].file_search_call.search_results"]
    });

    const text = response.output_text || "";
    const fileSearch = response.output?.find?.(o => o.type === "file_search_call");
    const results = fileSearch?.results || [];
    const citations = results.map(r => ({
      filename: r.filename,
      preview: r.text?.slice(0, 300) || ""
    }));

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, citations })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Fallo interno" }) };
  }
}
