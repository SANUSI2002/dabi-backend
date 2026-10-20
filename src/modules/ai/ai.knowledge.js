import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import prisma from '../../config/db.js';
import { PRIVATE_BUCKETS, privateStorageClient } from '../../config/privateStorage.js';
import { downloadVerified, scanEvidence } from '../platform/platform.evidence-scanner.js';
import { aiError } from './ai.config.js';
import { aiAccess } from './ai.access.js';
import { evidenceScannerConfigured } from '../../config/evidenceScanner.js';

export const knowledgeReference = (doc, passage, label) => ({ label, kind:'KNOWLEDGE_REFERENCE', documentId:doc.id, revision:doc.revision,
  sourceTitle:doc.metadata.title, author:doc.metadata.authors, edition:doc.metadata.edition, publicationDate:doc.metadata.publicationDate || null,
  pageNumber:passage.pageNumber, pageLabel:passage.pageLabel || null, locator:passage.pageLabel?`Page ${passage.pageLabel}`:`PDF page ${passage.pageNumber}` });
export const sourceAllowed = (doc, access, now = new Date()) => !!doc && doc.status==='PUBLISHED' && doc.scanStatus==='CLEAN'
  && new Date(`${doc.metadata.reviewBy}T23:59:59Z`)>now && doc.metadata.rightsConfirmed===true
  && doc.metadata.audiences?.includes(access.category);
export async function knowledgeReferencesAvailable(userId, refs, db=prisma) {
  if(!refs?.length) return true;
  const access=await aiAccess(userId,db);
  if(!access.features.knowledge) return false;
  const docs=await db.aiKnowledgeDocument.findMany({where:{id:{in:refs.map(r=>r.documentId)}}});
  return refs.every(ref=>docs.some(d=>d.id===ref.documentId && d.revision===ref.revision && sourceAllowed(d,access)));
}
// No public source catalogue/search/view endpoint exists. Only this internal adapter gets text.
export async function retrieveKnowledge(userId, question, db=prisma) {
  const access=await aiAccess(userId,db);
  if(!access.features.knowledge) return [];
  if(/\b(?:reproduce|verbatim|download|full text|entire book|whole book|all pages|copy the chapter)\b/i.test(question)) return [];
  const terms=[...new Set((question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]))].slice(0,24).join(' | ');
  if(!terms)return [];
  // Bounded keyword retrieval; no patient text is sent to an external search engine.
  const rows=await db.$queryRaw`
    SELECT p.id,p.document_id AS "documentId",p.page_number AS "pageNumber",p.page_label AS "pageLabel",p.text
    FROM ai_knowledge_passages p JOIN ai_knowledge_documents d ON d.id=p.document_id
    WHERE d.status='PUBLISHED' AND d.scan_status='CLEAN' AND p.quality='APPROVED'
      AND d.metadata->'audiences' ? ${access.category}
      AND d.metadata->>'rightsConfirmed'='true'
      AND (d.metadata->>'reviewBy')::date >= CURRENT_DATE
      AND to_tsvector('english',p.text) @@ to_tsquery('english',${terms})
    ORDER BY ts_rank_cd(to_tsvector('english',p.text),to_tsquery('english',${terms})) DESC,p.id LIMIT 4`;
  const docs=await db.aiKnowledgeDocument.findMany({where:{id:{in:rows.map(r=>r.documentId)}}});
  return rows.filter(p=>sourceAllowed(docs.find(d=>d.id===p.documentId),access)).map((p,i)=>{
    const doc=docs.find(d=>d.id===p.documentId);
    return {...knowledgeReference(doc,p,`K${i+1}`),text:p.text.slice(0,7000)};
  });
}
export function validateKnowledgeAnswer(text, passages) {
  const cited=[...text.matchAll(/\[K(\d+)\]/g)].map(m=>`K${m[1]}`);
  if(cited.some(label=>!passages.some(p=>p.label===label))) throw aiError(503,'AI_RESPONSE_INVALID','Sabi returned an unsupported source reference.');
  if(passages.length && !cited.length) throw aiError(503,'AI_RESPONSE_INVALID','Sabi did not cite its retrieved reference evidence.');
  // References are allowed; redistributing long verbatim book passages is not.
  const words=value=>value.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
  const answer=words(text), phrases=new Set();
  for(const p of passages){const w=words(p.text);for(let i=0;i<=w.length-26;i++)phrases.add(w.slice(i,i+26).join(' '));}
  for(let i=0;i<=answer.length-26;i++) if(phrases.has(answer.slice(i,i+26).join(' '))) throw aiError(503,'AI_RESPONSE_INVALID','Sabi returned too much source text. Ask for a concise explanation instead.');
  return [...new Set(cited)].map(label=>{const ref={...passages.find(p=>p.label===label)};delete ref.text;return ref;});
}
export function parseKnowledgePdf(bytes) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./ai.knowledge-parser.js',import.meta.url),{workerData:{bytes},resourceLimits:{maxOldGenerationSizeMb:256}});
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('PDF_PROCESSING_TIMEOUT'));},45000);
    worker.once('message',data=>{clearTimeout(timer);worker.terminate();if(data.error)reject(new Error(data.error));else resolve(data);});
    worker.once('error',()=>{clearTimeout(timer);reject(new Error('PDF_EXTRACTION_FAILED'));});
    worker.once('exit',code=>{if(code!==0){clearTimeout(timer);reject(new Error('PDF_EXTRACTION_FAILED'));}});
  });
}
export async function processKnowledgeQueue({db=prisma,client,scan=scanEvidence,parse=parseKnowledgePdf}={}) {
  if(scan===scanEvidence&&!evidenceScannerConfigured())return 0;
  const now=new Date();
  const doc=await db.aiKnowledgeDocument.findFirst({where:{status:{in:['UPLOADED','PROCESSING']},OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:now}}]},orderBy:{createdAt:'asc'}});
  if(!doc)return 0;
  const lease=randomUUID();
  const claimed=await db.aiKnowledgeDocument.updateMany({where:{id:doc.id,status:doc.status,version:doc.version,OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:now}}]},data:{status:'PROCESSING',leaseToken:lease,leaseExpiresAt:new Date(Date.now()+300000),attempts:{increment:1}}});
  if(!claimed.count)return 0;
  try{
    if(doc.attempts>=3)throw new Error('PROCESSING_RETRIES_EXHAUSTED');
    client ||= privateStorageClient();
    const bytes=await downloadVerified(client,PRIVATE_BUCKETS.clinicalDocuments,doc.storageKey,{size:doc.byteSize,sha256:doc.sha256,maxBytes:10485760});
    const screened=await scan(bytes,{contentType:'application/pdf',byteSize:doc.byteSize});
    if(screened.verdict!=='CLEAN'){
      await db.aiKnowledgeDocument.updateMany({where:{id:doc.id,leaseToken:lease},data:{status:'FAILED',scanStatus:['INFECTED','REJECTED'].includes(screened.verdict)?screened.verdict:'FAILED',errorCode:'DOCUMENT_NOT_CLEAN',leaseToken:null,leaseExpiresAt:null,version:{increment:1}}});return 1;
    }
    const result=await parse(bytes);
    await db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(739294, 2)::text`;
      const changed=await tx.aiKnowledgeDocument.updateMany({where:{id:doc.id,status:'PROCESSING',leaseToken:lease},data:{status:'REVIEW_REQUIRED',scanStatus:'CLEAN',scannerVersion:screened.scannerVersion,pageCount:result.pages.length,leaseToken:null,leaseExpiresAt:null,errorCode:null,version:{increment:1}}});
      if(changed.count){await tx.aiKnowledgePassage.deleteMany({where:{documentId:doc.id}});await tx.aiKnowledgePassage.createMany({data:result.pages.map(p=>({id:randomUUID(),documentId:doc.id,...p,quality:'REVIEW_REQUIRED'}))});}
    });
  }catch{
    await db.aiKnowledgeDocument.updateMany({where:{id:doc.id,leaseToken:lease},data:{status:'FAILED',errorCode:'SCAN_OR_EXTRACTION_FAILED',leaseToken:null,leaseExpiresAt:null,version:{increment:1}}});
  }
  return 1;
}
export const knowledgeChecksum=bytes=>createHash('sha256').update(bytes).digest('hex');
