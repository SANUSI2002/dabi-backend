import prisma from '../../config/db.js';
export const transaction=(f)=>prisma.$transaction(f);
export const patient=(tx,id)=>tx.userRole.findFirst({where:{userId:id,role:'PATIENT'},select:{id:true}});
export const order=(tx,id,patientId)=>tx.order.findFirst({where:{id,patientId,status:'PENDING_PAYMENT'},include:{patient:{select:{email:true}},reservation:{include:{allocations:true}}}});
export const existing = (tx, orderId, idempotencyKey) => tx.paymentAttempt.findUnique({
  where: { orderId_idempotencyKey: { orderId, idempotencyKey } },
});
export const attempt=(tx,data)=>tx.paymentAttempt.create({data});
export const initialized=(tx,id,data)=>tx.paymentAttempt.update({where:{id},data});
export const paymentStatus=(patientId,orderId)=>prisma.paymentAttempt.findFirst({where:{orderId,order:{patientId}},orderBy:{createdAt:'desc'},select:{provider:true,providerReference:true,status:true,amountMinor:true,currency:true,authorizationUrl:true,accessCode:true,expiresAt:true,createdAt:true}});
export const webhookAttempt=(tx,reference)=>tx.paymentAttempt.findUnique({where:{providerReference:reference},include:{order:{include:{fulfilments:true,reservation:{include:{allocations:true}}}}}});
export const event=(tx,key)=>tx.paymentAttemptEvent.findUnique({where:{providerEventKey:key}});
export const eventCreate=(tx,data)=>tx.paymentAttemptEvent.create({data});
export const paid=(tx,id)=>tx.paymentAttempt.update({where:{id},data:{status:'SUCCESS',completedAt:new Date()}});
export const failed=(tx,id,status)=>tx.paymentAttempt.update({where:{id},data:{status,completedAt:new Date()}});
export const orderPaid=(tx,id)=>tx.order.updateMany({where:{id,status:'PENDING_PAYMENT'},data:{status:'PAID'}});
export const fulfilmentsPaid=(tx,orderId)=>tx.orderFulfilment.updateMany({where:{orderId,status:'AWAITING_PAYMENT'},data:{status:'AWAITING_PHARMACIST_REVIEW'}});
export const orderFailed=(tx,id)=>tx.order.updateMany({where:{id,status:'PENDING_PAYMENT'},data:{status:'PAYMENT_FAILED'}});
export const fulfilmentsFailed=(tx,orderId)=>tx.orderFulfilment.updateMany({where:{orderId,status:'AWAITING_PAYMENT'},data:{status:'CANCELLED'}});
export const releaseReservation=(tx,id)=>tx.reservation.updateMany({where:{id,status:'CONVERTED'},data:{status:'EXPIRED',releasedAt:new Date()}});
export const restore=(tx,id,quantity)=>tx.pharmacyInventoryItem.update({where:{id},data:{availableQuantity:{increment:quantity}}});
export const audit=(tx,userId,type,id)=>tx.activityLog.create({data:{userId,type,description:'Payment state changed',meta:{id}}});
