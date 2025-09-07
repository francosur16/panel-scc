export async function handler(event) {
  try {
    const qs = event?.queryStringParameters || {};
    const skip = Number(qs.skip) || 0;
    const limit = Number(qs.limit) || undefined;
    const { ingest } = await import("../../scripts/ingest-pdfs.mjs");
    const res = await ingest({ skip, limit });
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, res }) };
  } catch (err) {
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
}
