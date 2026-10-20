import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

try {
  const bytes = Buffer.from(workerData.bytes);
  if (!bytes.length || bytes.length > 3500000) throw new Error('SIZE');
  let pageCount;
  if (workerData.contentType === 'application/pdf') {
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('SIGNATURE');
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
    if (pdf.isEncrypted) throw new Error('ENCRYPTED');
    pageCount = pdf.getPageCount();
  } else {
    const type = workerData.contentType;
    if (!(type === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
      && !(type === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255,216,255])))) throw new Error('SIGNATURE');
    const meta = await sharp(bytes, { limitInputPixels: 16000000 }).metadata();
    if (!meta.width || !meta.height || (meta.pages || 1) !== 1) throw new Error('IMAGE');
    pageCount = 1;
  }
  if (pageCount < 1 || pageCount > 20) throw new Error('PAGES');
  parentPort.postMessage({ pageCount });
} catch { parentPort.postMessage({ error: 'UNSUPPORTED' }); }
