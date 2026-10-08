import { recordAudit } from '../audit/audit.service.js';

export const audit = (tx, userId, type, prescriptionId) => tx.activityLog.create({ data: { userId, type, description: 'Prescription state changed', meta: { prescriptionId } } });
/** The patient's Activity log entry for a professional's action on their prescription. */
export const trail = (db, userId, patientId, action, prescriptionId, options) => recordAudit(db, { actorUserId: userId, subjectUserId: patientId, action, resourceType: 'prescription', resourceId: prescriptionId }, options);
