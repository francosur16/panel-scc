// scripts/ingest-pdfs.mjs
// Uso:
//   node scripts/ingest-pdfs.mjs ./documentos
//   node scripts/ingest-pdfs.mjs ./documentos --force
//   node scripts/ingest-pdfs.mjs ./documentos --delete-removed
//
// Requiere: npm i openai dotenv  (Node 18+)

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const FOLDER = process.argv[2] || './documentos';
const FLAGS = new Set(process.argv.slice(3));
const FORCE = FLAGS.has('--force');                 // fuerza re-subida aunque exista
const DELETE_REMOVED = FLAGS.has('--delete-removed'); // elimina del VS lo que no esté en tu carpeta

const VECTOR_STORE_ID =
  process.env.VECTOR_STORE_ID || 'vs_6898ba92d884819186f9c2d909ff17e0';
const ASSISTANT_ID = process.env.ASSISTANT_ID;

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Falta OPENAI_API_KEY en .env');
  process.exit(1);
}
if (!VECTOR_STORE_ID) {
  console.error('❌ Falta VECTOR_STORE_ID en .env o en el script');
  process.exit(1);
}
if (!fs.existsSync(FOLDER)) {
  console.error('❌ No existe la carpeta:', FOLDER);
  process.exit(1);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Normalizador para comparar nombres de archivo de forma robusta
function normFilename(s = '') {
  return path
    .basename(String(s))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // sin acentos
}

async function listVSFiles(vectorStoreId) {
  const map = new Map(); // normFilename -> { file_id, filename }
  let after = undefined;
  do {
    const page = await client.beta.vectorStores.files.list({
      vector_store_id: vectorStoreId,
      limit: 100,
      after,
    });
    for (const item of page.data) {
      // Obtener el filename real (hay que resolverlo con files.retrieve)
      try {
        const f = await client.files.retrieve(item.file_id);
        const key = normFilename(f.filename);
        if (!map.has(key)) map.set(key, { file_id: f.id, filename: f.filename });
      } catch {
        // Si falla el retrieve (raro), igual no cortamos todo
      }
    }
    after = page.has_more ? page.last_id : undefined;
  } while (after);

  return map;
}

async function main() {
  // 1) Local PDFs
  const localFiles = fs
    .readdirSync(FOLDER)
    .filter((f) => f.toLowerCase().endsWith('.pdf'));

  if (localFiles.length === 0) {
    console.error('❌ No hay PDFs en', FOLDER);
    process.exit(1);
  }

  // 2) Archivos ya existentes en el Vector Store
  process.stdout.write('🔎 Listando archivos existentes en el Vector Store...\n');
  const vsFiles = await listVSFiles(VECTOR_STORE_ID);

  // 3) Decidir cuáles subir/omitir
  const toUpload = [];
  const skipped = [];

  for (const fname of localFiles) {
    const key = normFilename(fname);
    if (!FORCE && vsFiles.has(key)) {
      skipped.push(fname);
    } else {
      toUpload.push(fname);
    }
  }

  // 4) Subir (si hay)
  let uploadedCount = 0;
  if (toUpload.length > 0) {
    console.log('⬆️ Subiendo PDFs desde:', path.resolve(FOLDER));
    toUpload.forEach((f) => console.log(' -', f));

    const streams = toUpload.map((f) =>
      fs.createReadStream(path.join(FOLDER, f))
    );

    const batch = await client.beta.vectorStores.fileBatches.uploadAndPoll({
      vector_store_id: VECTOR_STORE_ID,
      files: streams,
    });

    uploadedCount = batch?.file_counts?.completed || 0;
    console.log('Estado:', batch.status);
    console.log('Conteo:', batch.file_counts);
  } else {
    console.log('✔️ No hay archivos para subir (todo estaba cargado).');
  }

  // 5) (Opcional) eliminar del VS lo que ya no exista localmente
  let deletedCount = 0;
  if (DELETE_REMOVED) {
    // set de locales normalizados
    const localSet = new Set(localFiles.map(normFilename));

    const toDelete = [];
    for (const [key, info] of vsFiles.entries()) {
      if (!localSet.has(key)) {
        toDelete.push(info);
      }
    }

    if (toDelete.length) {
      console.log('🗑️ Eliminando del Vector Store (no están en la carpeta local):');
      for (const info of toDelete) {
        console.log(' -', info.filename);
        try {
          await client.beta.vectorStores.files.del({
            vector_store_id: VECTOR_STORE_ID,
            file_id: info.file_id,
          });
          deletedCount++;
        } catch (e) {
          console.warn('  (no se pudo eliminar)', info.filename, e?.message || e);
        }
      }
    } else {
      console.log('✔️ No hay archivos para eliminar del Vector Store.');
    }
  }

  // 6) (Opcional) asegurar que el asistente tenga el VS adjunto
  if (ASSISTANT_ID) {
    await client.beta.assistants.update({
      assistant_id: ASSISTANT_ID,
      tool_resources: { file_search: { vector_store_ids: [VECTOR_STORE_ID] } },
    });
    console.log('🤖 Asistente actualizado con VS', VECTOR_STORE_ID);
  }

  // 7) Resumen
  console.log('\n📊 Resumen');
  console.log(' - Subidos   :', uploadedCount);
  console.log(' - Omitidos  :', skipped.length, skipped.length ? `(${skipped.join(', ')})` : '');
  if (DELETE_REMOVED) console.log(' - Eliminados:', deletedCount);
  console.log('Listo ✅');
}

main().catch((err) => {
  console.error('❌ Error:', err?.response?.data ?? err);
  process.exit(1);
});
