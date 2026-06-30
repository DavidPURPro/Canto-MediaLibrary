/**
 * fix_blob_content_type.js
 * 
 * Corrige le Content-Type des blobs Azure pour les extensions image
 * mal identifiées (.jfif, .thm, .bmp, .tif, .tiff, etc.)
 * 
 * Usage :
 *   node fix_blob_content_type.js
 * 
 * Variables d'environnement requises (même .env que server.js) :
 *   AZURE_STORAGE_CONNECTION_STRING
 *   AZURE_STORAGE_CONTAINER
 *   DATABASE_URL  (ou PG_HOST / PG_USER / PG_PASSWORD / PG_DATABASE / PG_PORT)
 */

require('dotenv').config();
const { BlobServiceClient } = require('@azure/storage-blob');
const { Pool } = require('pg');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const MIME_MAP = {
  '.jfif': 'image/jpeg',
  '.jpe':  'image/jpeg',
  '.thm':  'image/jpeg',   // thumbnails DJI/Canon = JPEG
  '.bmp':  'image/bmp',
  '.tif':  'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heif': 'image/heif',
  '.heic': 'image/heic',
  '.dng':  'image/x-adobe-dng',
  '.cr2':  'image/x-canon-cr2',
  '.nef':  'image/x-nikon-nef',
  '.arw':  'image/x-sony-arw',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
};

// Extensions à cibler (celles qui posent problème)
const TARGET_EXTENSIONS = Object.keys(MIME_MAP);

// ── Clients ───────────────────────────────────────────────────────────────────

const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING
);
const containerClient = blobServiceClient.getContainerClient(
  process.env.AZURE_STORAGE_CONTAINER
);

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getExt(filename) {
  return path.extname(filename).toLowerCase();
}

function getMime(filename) {
  return MIME_MAP[getExt(filename)] || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Récupération des fichiers depuis la base de données...');

  // Récupère tous les fichiers dont l'extension est dans notre liste
  const extConditions = TARGET_EXTENSIONS.map(e => `'%${e}'`).join(', ');
  const result = await pool.query(`
    SELECT nom_fichier, lien_telechargement
    FROM documents
    WHERE LOWER(nom_fichier) LIKE ANY(ARRAY[${extConditions}])
    ORDER BY nom_fichier
  `);

  const files = result.rows;
  console.log(`📦 ${files.length} fichier(s) trouvé(s) à vérifier.\n`);

  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const filename = file.nom_fichier;
    const correctMime = getMime(filename);

    if (!correctMime) {
      console.log(`⏭  SKIP  ${filename} (extension non gérée)`);
      skipped++;
      continue;
    }

    try {
      const blockBlobClient = containerClient.getBlockBlobClient(filename);

      // Récupère les propriétés actuelles
      const props = await blockBlobClient.getProperties();
      const currentMime = props.contentType || '';

      if (currentMime === correctMime) {
        console.log(`✅ OK    ${filename}  (déjà "${correctMime}")`);
        skipped++;
        continue;
      }

      // Met à jour uniquement le Content-Type, conserve les autres headers
      await blockBlobClient.setHTTPHeaders({
        blobContentType:        correctMime,
        blobContentDisposition: props.contentDisposition || 'inline',
        blobCacheControl:       props.cacheControl,
        blobContentEncoding:    props.contentEncoding,
        blobContentLanguage:    props.contentLanguage,
        blobContentMD5:         props.contentMD5,
      });

      console.log(`🔧 FIXED ${filename}  "${currentMime}" → "${correctMime}"`);
      fixed++;

    } catch (err) {
      console.error(`❌ ERROR ${filename}: ${err.message}`);
      errors++;
    }
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Corrigés  : ${fixed}
⏭  Ignorés   : ${skipped}
❌ Erreurs   : ${errors}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  await pool.end();
}

main().catch(err => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});
