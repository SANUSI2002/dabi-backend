import { Blob, Buffer } from 'node:buffer';
import { cloudmersiveConfigured, evidenceUploadMaxBytes } from '../../config/evidenceScanner.js';

const ENDPOINT = 'https://api.cloudmersive.com/virus/scan/file/advanced';
const THREAT_FLAGS = ['ContainsExecutable', 'ContainsInvalidFile', 'ContainsScript', 'ContainsPasswordProtectedFile',
  'ContainsRestrictedFileFormat', 'ContainsMacros', 'ContainsXmlExternalEntities', 'ContainsInsecureDeserialization',
  'ContainsHtml', 'ContainsUnsafeArchive', 'ContainsOleEmbeddedObject', 'ContainsUnwantedAction'];
const FORMATS = { 'application/pdf': ['PDF'], 'image/jpeg': ['JPG', 'JPEG'], 'image/png': ['PNG'] };
const REQUIRED_FLAGS = THREAT_FLAGS.slice(0, 6);
const fail = (code) => { throw new Error(code); };

// Only credential evidence may call this adapter. It deliberately has no URL
// scanning option, no arbitrary endpoint, and never transmits Supabase keys/URLs.
export async function scanWithCloudmersive(bytes, { contentType } = {}, fetcher = globalThis.fetch) {
  if (!cloudmersiveConfigured()) fail('CLOUDMERSIVE_NOT_CONFIGURED');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail('EVIDENCE_BYTES_INVALID');
  if (bytes.length > evidenceUploadMaxBytes()) fail('CLOUDMERSIVE_FILE_TOO_LARGE');
  if (!FORMATS[contentType]) fail('EVIDENCE_CONTENT_TYPE_INVALID');
  const body = new globalThis.FormData();
  const extension = FORMATS[contentType][0].toLowerCase();
  // Do not disclose the applicant's name, registration number or original filename.
  body.append('inputFile', new Blob([bytes], { type: contentType }), `credential.${extension}`);
  let response;
  try {
    response = await fetcher(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: globalThis.AbortSignal.timeout(60000),
      headers: { Apikey: process.env.CLOUDMERSIVE_API_KEY.trim(), Accept: 'application/json',
        allowExecutables: 'false', allowInvalidFiles: 'false', allowScripts: 'false',
        allowPasswordProtectedFiles: 'false', allowMacros: 'false', allowUnsafeArchives: 'false',
        allowOleEmbeddedObject: 'false', allowUnwantedAction: 'false', restrictFileTypes: '.pdf,.jpg,.jpeg,.png' },
      body,
    });
  } catch { fail('CLOUDMERSIVE_UNAVAILABLE'); }
  if (response.status === 401 || response.status === 403) fail('CLOUDMERSIVE_AUTH_FAILED');
  if (response.status === 429) fail('CLOUDMERSIVE_RATE_LIMITED');
  if (response.status === 413) fail('CLOUDMERSIVE_FILE_TOO_LARGE');
  if (!response.ok) fail('CLOUDMERSIVE_UNAVAILABLE');
  // Do not log provider bodies: they may contain document metadata or filenames.
  let result;
  try {
    const text = await response.text();
    if (text.length > 100000) fail('CLOUDMERSIVE_REPLY_INVALID');
    result = JSON.parse(text);
  } catch { fail('CLOUDMERSIVE_REPLY_INVALID'); }
  // The real provider uses null (not []) when no virus was found.
  // Missing or other non-array values remain invalid and fail closed.
  if (!result || typeof result.CleanResult !== 'boolean' || !(result.FoundViruses === null || Array.isArray(result.FoundViruses))
    || REQUIRED_FLAGS.some((key) => typeof result[key] !== 'boolean')
    || THREAT_FLAGS.some((key) => result[key] !== undefined && typeof result[key] !== 'boolean')) fail('CLOUDMERSIVE_REPLY_INVALID');
  const scannerVersion = 'Cloudmersive advanced API v1'; // Protocol label, NOT a claimed engine/signature version.
  if (result.FoundViruses?.length) return { verdict: 'INFECTED', scannerVersion, signature: 'CLOUDMERSIVE_MALWARE_DETECTED' };
  const unsafe = THREAT_FLAGS.some((key) => result[key] === true);
  if (!result.CleanResult || unsafe) return { verdict: 'REJECTED', scannerVersion };
  const format = typeof result.VerifiedFileFormat === 'string' ? result.VerifiedFileFormat.replace(/^\./, '').toUpperCase() : '';
  if (!FORMATS[contentType].includes(format)) fail('CLOUDMERSIVE_FORMAT_MISMATCH');
  return { verdict: 'CLEAN', scannerVersion };
}
