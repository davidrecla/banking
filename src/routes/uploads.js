import { jsonResponse, errorResponse } from '../lib/auth.js';

// Intentionally NO type/size restrictions here — this endpoint exists so
// uploaded content can be exercised against WAF Content Scanning / malware
// detection (e.g. the EICAR test file) and DLP rules during the demo.

export async function handleUploadFile(request, env, auth) {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get('file');
  if (!file || typeof file === 'string') {
    return errorResponse('multipart/form-data with a "file" field is required', 400);
  }

  const id = crypto.randomUUID();
  const r2Key = `uploads/${auth.sub}/${id}-${file.name}`;

  await env.BANK_BUCKET.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' }
  });

  await env.BANK_DB
    .prepare('INSERT INTO uploads (id, user_id, filename, content_type, size, r2_key, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, auth.sub, file.name, file.type || null, file.size, r2Key, new Date().toISOString())
    .run();

  return jsonResponse({ id, filename: file.name, contentType: file.type, size: file.size }, 201);
}

export async function handleListUploads(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare('SELECT id, filename, content_type, size, uploaded_at FROM uploads WHERE user_id = ? ORDER BY uploaded_at DESC')
    .bind(auth.sub)
    .all();

  return jsonResponse({ uploads: results });
}

export async function handleDownloadUpload(request, env, auth, uploadId) {
  const upload = await env.BANK_DB
    .prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?')
    .bind(uploadId, auth.sub)
    .first();
  if (!upload) return errorResponse('File not found', 404);

  const object = await env.BANK_BUCKET.get(upload.r2_key);
  if (!object) return errorResponse('File not found in storage', 404);

  return new Response(object.body, {
    headers: {
      'Content-Type': upload.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${upload.filename}"`,
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export async function handleDeleteUpload(request, env, auth, uploadId) {
  const upload = await env.BANK_DB
    .prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?')
    .bind(uploadId, auth.sub)
    .first();
  if (!upload) return errorResponse('File not found', 404);

  await env.BANK_BUCKET.delete(upload.r2_key);
  await env.BANK_DB.prepare('DELETE FROM uploads WHERE id = ?').bind(uploadId).run();

  return jsonResponse({ message: 'File deleted' });
}
