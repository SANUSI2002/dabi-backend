import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { protect } from '../../middleware/authMiddleware.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { sendPatientVerification } from '../auth/auth.controller.js';
import { verificationEmailConfigured, verificationEmailAllowedFor } from '../auth/auth.email.js';
import { adminAudit, allow, handle, reason, ccError } from '../command-centre/cc.common.js';
import { AI_PROFESSIONS, aiAccess, enrollmentSchema, accessSettingsSchema, featureSchema } from './ai.access.js';
import { allowanceLock } from './ai.allowances.js';

export const aiAccountRoutes = Router();
const write = body => validate(z.object({body}));
const signup = z.object({ email:z.email().transform(v=>v.toLowerCase()), password:z.string().min(12).max(128), fullName:z.string().trim().min(2).max(120), consentGiven:z.literal(true), enrollment:enrollmentSchema }).strict();
const baseUrl = () => `${(process.env.SABI_AI_PORTAL_URL || process.env.CLIENT_URL || 'http://127.0.0.1:5173').replace(/\/$/,'')}/ai`;
const enrolData = input => ({ kind:input.kind, status:input.kind==='PERSONAL'?'APPROVED':'PENDING', details:input, expiresAt:input.expiresAt ? new Date(`${input.expiresAt}T23:59:59Z`) : null });
aiAccountRoutes.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
aiAccountRoutes.get('/catalogue', handle(async()=>({ professions:AI_PROFESSIONS, accountKinds:['PERSONAL','PROFESSIONAL','BUSINESS'] })));
aiAccountRoutes.post('/register', createLimiter({kind:'ai-registration',max:5}), write(signup), handle(async req=>{
  if (!verificationEmailConfigured() || !verificationEmailAllowedFor(req.body.email)) throw ccError('EMAIL_UNAVAILABLE',503,'Verification email is temporarily unavailable.');
  const password = await bcrypt.hash(req.body.password,12);
  let user;
  try {
    user = await prisma.$transaction(tx=>tx.user.create({data:{patientId:`SAI-${randomUUID()}`,email:req.body.email,password,full_name:req.body.fullName,accountStatus:'PENDING',
      roles:{create:{role:'PATIENT'}},profile:{create:{consentGiven:true,consentGivenAt:new Date()}},aiEnrollment:{create:enrolData(req.body.enrollment)}},select:{id:true,email:true}}));
  } catch(e) { if(e.code==='P2002') throw ccError('ACCOUNT_EXISTS',409,'An account already exists. Sign in or recover your password, then choose your AI account type.'); throw e; }
  const emailSent = await sendPatientVerification(user,baseUrl());
  return {registered:true,emailSent,message:emailSent?'Account created. Check your email to verify it.':'Account created. Use Resend verification email to request another link.'};
}));
aiAccountRoutes.post('/resend-verification', createLimiter({kind:'ai-verification',max:5}), write(z.object({email:z.email()}).strict()), handle(async req=>{
  const user=await prisma.user.findUnique({where:{email:req.body.email.toLowerCase()},include:{aiEnrollment:true}});
  if(user?.aiEnrollment && ['ACTIVE','PENDING'].includes(user.accountStatus) && !user.emailVerifiedAt && verificationEmailAllowedFor(user.email)) {
    const recent=await prisma.emailVerificationToken.findFirst({where:{userId:user.id,createdAt:{gt:new Date(Date.now()-60000)},revokedAt:null}});
    if(!recent) await sendPatientVerification(user,baseUrl());
  }
  return {message:'If this account needs verification, a new link has been requested.'};
}));
aiAccountRoutes.use(protect);
aiAccountRoutes.get('/me',handle(req=>aiAccess(req.user.id)));
aiAccountRoutes.post('/enrollment',write(z.object({expectedVersion:z.number().int().min(0),enrollment:enrollmentSchema}).strict()),handle(req=>prisma.$transaction(async tx=>{
  await allowanceLock(tx);
  const before=await tx.aiEnrollment.findUnique({where:{userId:req.user.id}});
  if(before?.status==='SUSPENDED')throw ccError('AI_ACCOUNT_SUSPENDED',403,'Contact Sabi operations to review the restriction on this AI account.');
  if((before?.version||0)!==req.body.expectedVersion) throw ccError('VERSION_CONFLICT',409,'Your application changed. Reload before submitting.');
  if(before) await tx.aiEnrollment.update({where:{userId:req.user.id},data:{...enrolData(req.body.enrollment),version:{increment:1},decidedByUserId:null,decisionReason:null}});
  else await tx.aiEnrollment.create({data:{userId:req.user.id,...enrolData(req.body.enrollment)}});
  return aiAccess(req.user.id,tx);
})));

export const aiAccountAdminRoutes=Router();
aiAccountAdminRoutes.use(allow('platform.settings.manage'));
aiAccountAdminRoutes.get('/policy',handle(()=>prisma.aiAccessPolicy.findUnique({where:{id:'global'}})));
aiAccountAdminRoutes.post('/policy',requireRecentMfa,write(z.object({expectedVersion:z.number().int().min(1),settings:accessSettingsSchema,reason}).strict()),handle(req=>prisma.$transaction(async tx=>{
  await allowanceLock(tx);
  const before=await tx.aiAccessPolicy.findUnique({where:{id:'global'}});
  const changed=await tx.aiAccessPolicy.updateMany({where:{id:'global',version:req.body.expectedVersion},data:{settings:req.body.settings,version:{increment:1}}});
  if(!changed.count) throw ccError('VERSION_CONFLICT',409,'Feature policy changed. Reload before saving.');
  await adminAudit(tx,req,{summary:'Updated Sabi AI feature access',resourceType:'ai-access-policy',resourceId:'global',reason:req.body.reason,before:before.settings,after:req.body.settings});
  return tx.aiAccessPolicy.findUnique({where:{id:'global'}});
})));
aiAccountAdminRoutes.get('/',handle(async req=>{
  const query=z.object({offset:z.coerce.number().int().min(0).max(10000).default(0),status:z.enum(['PENDING','APPROVED','REJECTED','SUSPENDED']).optional()}).parse(req.query);
  const where=query.status?{status:query.status}:{};
  const [items,total]=await Promise.all([prisma.aiEnrollment.findMany({where,skip:query.offset,take:25,orderBy:[{createdAt:'desc'},{userId:'desc'}],include:{user:{select:{full_name:true,email:true}}}}),prisma.aiEnrollment.count({where})]);
  return {items,total,offset:query.offset};
}));
aiAccountAdminRoutes.post('/:id/features',requireRecentMfa,write(z.object({expectedVersion:z.number().int().min(1),featureOverrides:featureSchema.partial(),reason}).strict()),handle(req=>prisma.$transaction(async tx=>{
  await allowanceLock(tx);const id=z.uuid().parse(req.params.id);
  const before=await tx.aiEnrollment.findUnique({where:{userId:id}});
  if(!before)throw ccError('NOT_FOUND',404,'AI account application not found.');
  const changed=await tx.aiEnrollment.updateMany({where:{userId:id,version:req.body.expectedVersion},data:{featureOverrides:req.body.featureOverrides,version:{increment:1}}});
  if(!changed.count)throw ccError('VERSION_CONFLICT',409,'Account changed. Reload before saving.');
  await adminAudit(tx,req,{summary:'Updated individual AI feature overrides',subjectUserId:id,resourceType:'ai-enrollment',resourceId:id,reason:req.body.reason,before:before.featureOverrides,after:req.body.featureOverrides});
  return {updated:true};
})));
aiAccountAdminRoutes.post('/:id/decision',requireRecentMfa,write(z.object({expectedVersion:z.number().int().min(1),status:z.enum(['APPROVED','REJECTED','SUSPENDED']),verificationReference:z.string().trim().min(5).max(500),reason}).strict()),handle(req=>prisma.$transaction(async tx=>{
  await allowanceLock(tx);
  const id=z.uuid().parse(req.params.id);
  if(id===req.user.id) throw ccError('SELF_REVIEW',403,'Another authorised administrator must review your application.');
  const before=await tx.aiEnrollment.findUnique({where:{userId:id}});
  if(!before) throw ccError('NOT_FOUND',404,'Application not found.');
  if(req.body.status==='APPROVED' && before.expiresAt && before.expiresAt<=new Date()) throw ccError('LICENCE_EXPIRED',409,'A current licence is required.');
  const changed=await tx.aiEnrollment.updateMany({where:{userId:id,version:req.body.expectedVersion},data:{status:req.body.status,version:{increment:1},decidedByUserId:req.user.id,decisionReason:req.body.reason}});
  if(!changed.count) throw ccError('VERSION_CONFLICT',409,'Application changed. Reload before reviewing.');
  await adminAudit(tx,req,{summary:'Reviewed Sabi AI account application',subjectUserId:id,resourceType:'ai-enrollment',resourceId:id,reason:req.body.reason,before:{status:before.status},after:{status:req.body.status},extra:{verificationReference:req.body.verificationReference}});
  return {recorded:true};
})));
