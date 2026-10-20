import { Router, raw } from 'express';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { PRIVATE_BUCKETS, privateStorageClient, uploadPrivateObject, assertPrivateBucket } from '../../config/privateStorage.js';
import { downloadVerified } from '../platform/platform.evidence-scanner.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { adminAudit, allow, handle, reason, ccError } from '../command-centre/cc.common.js';
import { knowledgeChecksum } from './ai.knowledge.js';
import { evidenceUploadMaxBytes } from '../../config/evidenceScanner.js';

export const knowledgeMetadataSchema=z.object({
  title:z.string().trim().min(2).max(240), authors:z.string().trim().min(2).max(300),edition:z.string().trim().min(1).max(80),
  publicationDate:z.iso.date().nullable(),jurisdiction:z.string().trim().min(2).max(100),language:z.string().trim().min(2).max(60),
  specialty:z.string().trim().min(2).max(100),audiences:z.array(z.enum(['PERSONAL','PROFESSIONAL','BUSINESS'])).min(1).max(3),
  rightsBasis:z.string().trim().min(10).max(1000),rightsConfirmed:z.literal(true),reviewBy:z.iso.date(),
  sourceType:z.enum(['BOOK','EXTERNAL_GUIDELINE']),sourceUrl:z.url().max(1000).nullable(),
}).strict().refine(v=>new Date(`${v.reviewBy}T23:59:59Z`)>new Date(),{path:['reviewBy'],message:'Use a future review date.'})
  .refine(v=>!v.sourceUrl||new URL(v.sourceUrl).protocol==='https:',{path:['sourceUrl'],message:'Use an HTTPS publisher URL.'});
const write=body=>validate(z.object({body}));
const mutation=z.object({expectedVersion:z.number().int().min(1),reason}).strict();
const lock=tx=>tx.$queryRaw`SELECT pg_advisory_xact_lock(739294, 2)::text`;
const canonical=v=>JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))));
const docId=req=>z.uuid().parse(req.params.id);
async function document(tx,id){const row=await tx.aiKnowledgeDocument.findUnique({where:{id}});if(!row)throw ccError('NOT_FOUND',404,'Knowledge document not found.');return row;}
function version(doc,expected){if(doc.version!==expected)throw ccError('VERSION_CONFLICT',409,'This document changed. Reload before continuing.');}
function draft(doc){if(!['REVIEW_REQUIRED','APPROVED'].includes(doc.status))throw ccError('INVALID_STATE',409,'Only extracted, unpublished versions can be edited.');}
export const knowledgeRoutes=Router();
// A platform Sabi administrator with recent MFA is required for EVERY catalogue/file operation.
knowledgeRoutes.use(allow('platform.settings.manage'),requireRecentMfa,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
knowledgeRoutes.get('/documents',handle(async req=>{
  const q=z.object({offset:z.coerce.number().int().min(0).max(10000).default(0)}).parse(req.query);
  const [items,total]=await Promise.all([prisma.aiKnowledgeDocument.findMany({skip:q.offset,take:25,orderBy:[{createdAt:'desc'},{id:'desc'}],select:{id:true,familyId:true,revision:true,version:true,metadata:true,status:true,scanStatus:true,pageCount:true,errorCode:true,createdAt:true,publishedAt:true}}),prisma.aiKnowledgeDocument.count()]);
  return {items,total,offset:q.offset,maxUploadBytes:evidenceUploadMaxBytes()};
}));
knowledgeRoutes.post('/documents',write(z.object({id:z.uuid(),metadata:knowledgeMetadataSchema,byteSize:z.number().int().min(1).max(10485760),sha256:z.string().regex(/^[a-f0-9]{64}$/),replacesId:z.uuid().optional(),reason,scanDisclosureAccepted:z.literal(true)}).strict()),handle(req=>prisma.$transaction(async tx=>{
  await lock(tx);const input=req.body;
  if(input.byteSize>evidenceUploadMaxBytes())throw ccError('SCAN_FILE_LIMIT',422,`The configured scanner accepts PDF files up to ${evidenceUploadMaxBytes()} bytes. No paid scanner upgrade is performed automatically.`);
  const existing=await tx.aiKnowledgeDocument.findUnique({where:{id:input.id}});
  if(existing){if(existing.sha256!==input.sha256||existing.uploadedByUserId!==req.user.id||canonical(existing.metadata)!==canonical(input.metadata))throw ccError('IDEMPOTENCY_CONFLICT',409,'Upload identifier was already used.');return {id:existing.id,version:existing.version,status:existing.status};}
  let familyId=input.id,revision=1;
  if(input.replacesId){const previous=await document(tx,input.replacesId);familyId=previous.familyId;revision=(await tx.aiKnowledgeDocument.aggregate({where:{familyId},_max:{revision:true}}))._max.revision+1;}
  const row=await tx.aiKnowledgeDocument.create({data:{id:input.id,familyId,revision,status:'AWAITING_UPLOAD',metadata:input.metadata,sha256:input.sha256,byteSize:input.byteSize,storageKey:`ai-knowledge/${input.id}/source.pdf`,uploadedByUserId:req.user.id}});
  await adminAudit(tx,req,{summary:'Created private AI knowledge upload',resourceType:'ai-knowledge-document',resourceId:row.id,reason:input.reason,after:{status:row.status,revision}});
  return {id:row.id,version:row.version,status:row.status};
})));
knowledgeRoutes.put('/documents/:id/file',raw({type:'application/pdf',limit:'10mb'}),handle(async req=>{
  const doc=await document(prisma,docId(req));
  if(!Buffer.isBuffer(req.body)||req.body.length!==doc.byteSize||knowledgeChecksum(req.body)!==doc.sha256)throw ccError('INVALID_FILE',422,'The selected PDF does not match this upload.');
  if(['UPLOADED','PROCESSING','REVIEW_REQUIRED','APPROVED','PUBLISHED'].includes(doc.status))return {uploaded:true,status:doc.status};
  if(doc.status!=='AWAITING_UPLOAD')throw ccError('INVALID_STATE',409,'This upload is no longer awaiting a file. Refresh its status.');
  const client=privateStorageClient();
  try{await uploadPrivateObject(client,{bucket:PRIVATE_BUCKETS.clinicalDocuments,path:doc.storageKey,bytes:req.body,contentType:'application/pdf'});}
  catch(e){
    // A previous upload may have succeeded before its response was lost. Verify bytes, never overwrite.
    try{await downloadVerified(client,PRIVATE_BUCKETS.clinicalDocuments,doc.storageKey,{size:doc.byteSize,sha256:doc.sha256});}catch{throw e;}
  }
  await prisma.$transaction(async tx=>{await lock(tx);
    const changed=await tx.aiKnowledgeDocument.updateMany({where:{id:doc.id,status:'AWAITING_UPLOAD',version:doc.version},data:{status:'UPLOADED',version:{increment:1}}});
    if(!changed.count)throw ccError('VERSION_CONFLICT',409,'The document changed during upload. Reload its status.');
    await adminAudit(tx,req,{summary:'Uploaded private AI knowledge PDF for background screening',resourceType:'ai-knowledge-document',resourceId:doc.id});
  });return {uploaded:true,status:'UPLOADED'};
}));
knowledgeRoutes.get('/documents/:id',handle(async req=>{
  const doc=await document(prisma,docId(req));
  const pages=await prisma.aiKnowledgePassage.findMany({where:{documentId:doc.id},orderBy:{pageNumber:'asc'},select:{id:true,pageNumber:true,pageLabel:true,quality:true}});
  const safe={...doc};delete safe.storageKey;delete safe.leaseToken;return {...safe,pages};
}));
knowledgeRoutes.get('/documents/:id/pages/:page',handle(async req=>{
  const doc=await document(prisma,docId(req));
  if(doc.scanStatus!=='CLEAN')throw ccError('NOT_CLEAN',409,'Screening must finish before preview.');
  const page=z.coerce.number().int().min(1).max(1000).parse(req.params.page);
  const item=await prisma.aiKnowledgePassage.findUnique({where:{documentId_pageNumber:{documentId:doc.id,pageNumber:page}}});
  if(!item)throw ccError('NOT_FOUND',404,'Page not found.');return item;
}));
knowledgeRoutes.post('/documents/:id/preview',write(z.object({reason}).strict()),handle(async req=>{
  const doc=await document(prisma,docId(req));
  if(doc.scanStatus!=='CLEAN'||doc.status==='RETIRED')throw ccError('NOT_CLEAN',409,'A clean, retained document is required.');
  const client=privateStorageClient();await assertPrivateBucket(client,PRIVATE_BUCKETS.clinicalDocuments);
  const {data,error}=await client.storage.from(PRIVATE_BUCKETS.clinicalDocuments).createSignedUrl(doc.storageKey,60);
  if(error||!data?.signedUrl)throw ccError('PREVIEW_UNAVAILABLE',503,'Private preview is unavailable.');
  await adminAudit(prisma,req,{summary:'Previewed private AI knowledge source',resourceType:'ai-knowledge-document',resourceId:doc.id,reason:req.body.reason});
  return {url:data.signedUrl,expiresInSeconds:60};
}));
knowledgeRoutes.post('/documents/:id/page-review',write(mutation.extend({pageNumber:z.number().int().min(1).max(1000),text:z.string().max(30000),pageLabel:z.string().trim().min(1).max(40).nullable(),quality:z.enum(['APPROVED','EXCLUDED'])}).strict()),handle(req=>prisma.$transaction(async tx=>{
  await lock(tx);const doc=await document(tx,docId(req));version(doc,req.body.expectedVersion);draft(doc);
  if(doc.scanStatus!=='CLEAN')throw ccError('NOT_CLEAN',409,'Screening must finish first.');
  if(req.body.quality==='APPROVED'&&req.body.text.trim().length<40)throw ccError('UNREADABLE_PAGE',422,'Exclude unreadable pages or correct the extraction before approving.');
  const changed=await tx.aiKnowledgePassage.updateMany({where:{documentId:doc.id,pageNumber:req.body.pageNumber},data:{text:req.body.text,pageLabel:req.body.pageLabel,quality:req.body.quality}});
  if(!changed.count)throw ccError('NOT_FOUND',404,'Page not found.');
  await tx.aiKnowledgeDocument.update({where:{id:doc.id},data:{status:'REVIEW_REQUIRED',reviewedByUserId:null,reviewedAt:null,version:{increment:1}}});
  await adminAudit(tx,req,{summary:'Reviewed AI knowledge page extraction',resourceType:'ai-knowledge-document',resourceId:doc.id,reason:req.body.reason,after:{pageNumber:req.body.pageNumber,quality:req.body.quality}});return {recorded:true};
})));
knowledgeRoutes.post('/documents/:id/metadata',write(mutation.extend({metadata:knowledgeMetadataSchema}).strict()),handle(req=>prisma.$transaction(async tx=>{
  await lock(tx);const doc=await document(tx,docId(req));version(doc,req.body.expectedVersion);draft(doc);
  await tx.aiKnowledgeDocument.update({where:{id:doc.id},data:{metadata:req.body.metadata,status:'REVIEW_REQUIRED',reviewedByUserId:null,reviewedAt:null,version:{increment:1}}});
  await adminAudit(tx,req,{summary:'Updated draft knowledge metadata',resourceType:'ai-knowledge-document',resourceId:doc.id,reason:req.body.reason});return {updated:true};
})));
for(const action of ['approve','publish','retire','retry'])knowledgeRoutes.post(`/documents/:id/${action}`,write(mutation),handle(req=>prisma.$transaction(async tx=>{
  await lock(tx);const doc=await document(tx,docId(req));version(doc,req.body.expectedVersion);let data;
  if(action==='approve'){
    if(doc.uploadedByUserId===req.user.id)throw ccError('SELF_REVIEW',403,'A second Sabi administrator must approve this source.');
    if(doc.status!=='REVIEW_REQUIRED'||doc.scanStatus!=='CLEAN')throw ccError('INVALID_STATE',409,'Only clean, reviewed extraction can be approved.');
    const pages=await tx.aiKnowledgePassage.findMany({where:{documentId:doc.id},select:{quality:true}});
    if(!pages.length||pages.some(p=>p.quality==='REVIEW_REQUIRED')||!pages.some(p=>p.quality==='APPROVED'))throw ccError('REVIEW_INCOMPLETE',409,'Review every page and approve at least one usable page.');
    knowledgeMetadataSchema.parse(doc.metadata);data={status:'APPROVED',reviewedByUserId:req.user.id,reviewedAt:new Date()};
  }else if(action==='publish'){
    if(doc.status!=='APPROVED'||!doc.reviewedByUserId||doc.scanStatus!=='CLEAN')throw ccError('INVALID_STATE',409,'Approve this clean document version before publishing.');
    knowledgeMetadataSchema.parse(doc.metadata);
    await tx.aiKnowledgeDocument.updateMany({where:{familyId:doc.familyId,status:'PUBLISHED'},data:{status:'SUPERSEDED',version:{increment:1}}});data={status:'PUBLISHED',publishedAt:new Date()};
  }else if(action==='retire')data={status:'RETIRED',leaseToken:null,leaseExpiresAt:null};
  else{if(doc.status!=='FAILED'||doc.scanStatus==='INFECTED'||doc.scanStatus==='REJECTED')throw ccError('INVALID_STATE',409,'Replace unsafe files; retry is for processing failures only.');data={status:'UPLOADED',attempts:0,errorCode:null,leaseToken:null,leaseExpiresAt:null};}
  await tx.aiKnowledgeDocument.update({where:{id:doc.id},data:{...data,version:{increment:1}}});
  await adminAudit(tx,req,{summary:`AI knowledge source ${action}`,resourceType:'ai-knowledge-document',resourceId:doc.id,reason:req.body.reason,before:{status:doc.status},after:{status:data.status}});return {status:data.status};
})));
