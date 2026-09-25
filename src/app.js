import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';

import hospitalPlanRoutes from './modules/hospital-plans/hospital-plans.routes.js';
import organisationRoutes from './modules/organisations/organisations.routes.js';
import caregiverRoutes from './modules/caregivers/caregivers.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import profileRoutes from './modules/profile/profile.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import appointmentsRoutes from './modules/appointments/appointments.routes.js';
import medicationsRoutes from './modules/medications/medications.routes.js';
import vitalsRoutes from './modules/vitals/vitals.routes.js';
import healthMetricsRoutes from './modules/health-metrics/health-metrics.routes.js';
import medicalRecordsRoutes from './modules/medical-records/medical-records.routes.js';
import familyCareRoutes from './modules/family-care/family-care.routes.js';
import professionalRoutes from './modules/professionals/professionals.routes.js';
import doctorCareRoutes from './modules/doctor-care/doctor-care.routes.js';
import prescriptionRoutes from './modules/prescriptions/prescriptions.routes.js';
import pharmacyRoutes from './modules/pharmacies/pharmacies.routes.js';
import { discoveryRoutes, inventoryRoutes } from './modules/inventory/inventory.routes.js';
import pharmacyRequestRoutes from './modules/pharmacy-requests/pharmacy-requests.routes.js';
import reservationRoutes from './modules/reservations/reservation.routes.js';
import checkoutPricingRoutes from './modules/checkout-pricing/checkout-pricing.routes.js';
import orderRoutes from './modules/orders/orders.routes.js';
import { c as paymentController, paystackWebhook, paymentRoutes } from './modules/payments/payments.routes.js';
import deliveryRoutes from './modules/delivery/delivery.routes.js';
import fulfilmentRoutes from './modules/fulfilments/fulfilments.routes.js';
import { notFound, errorHandler } from './middleware/errorMiddleware.js';
import { globalLimiter, warnRateLimitFallback } from './middleware/rateLimitMiddleware.js';
import { trustedProxySetting } from './config/proxy.js';
import platformRoutes from './modules/platform/platform.routes.js';
import platformPackageRoutes, { publicPackageRoutes } from './modules/platform/platform.catalog.routes.js';
import { platformApplicationRoutes, publicApplicationRoutes } from './modules/platform/platform.applications.routes.js';
import emrPatientRoutes from './modules/emr/emr.patients.routes.js';
import hospitalEnrollmentRoutes from './modules/hospital-enrollments/hospital-enrollments.routes.js';
import hospitalAppointmentRoutes from './modules/hospital-appointments/hospital-appointments.routes.js';
import wellnessRoutes from './modules/wellness/wellness.routes.js';
import medicalDocumentRoutes, { internalDocumentScanRoutes } from './modules/medical-documents/medical-documents.routes.js';
import openApiRoutes from './docs/openapi.routes.js';

export const app = express();
app.set('trust proxy', trustedProxySetting());
warnRateLimitFallback();

// --- SECURITY PROTOCOLS ---
app.use(helmet());

app.use(cors({
  origin: (process.env.CLIENT_URLS || process.env.CLIENT_URL || 'http://localhost:5173').split(',').map((url) => url.trim()).filter(Boolean),
  credentials: true,
}));

app.use('/api', openApiRoutes);
app.use('/api/', globalLimiter);

app.post('/api/v1/payments/paystack/webhook', paystackWebhook, paymentController.webhook);
// Scanner callbacks are signed over the raw body, so they must precede the JSON parser.
app.use('/api/v1/internal/document-scans', internalDocumentScanRoutes);

// Private onboarding documents have a bounded parser before the default 100 KiB parser.
app.use('/api/v1/organisations', organisationRoutes);
app.use(express.json());

// --- MODULAR BUCKET ROUTING ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'success', message: 'Sabi Health backend is running securely' });
});

app.use('/api/v1/hospitals', hospitalPlanRoutes);
app.use('/api/v1/hospital-enrollments', hospitalEnrollmentRoutes);
app.use('/api/v1/hospital-appointments', hospitalAppointmentRoutes);
// Mounted before the '/api/v1' payment router, which requires sign-in for every path
// it sees — the wellness catalogue is public.
app.use('/api/v1/wellness', wellnessRoutes);
app.use('/api/v1/medical-documents', medicalDocumentRoutes);
app.use('/api/v1', caregiverRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/emr/organizations', emrPatientRoutes);
app.use('/api/v1/platform', platformRoutes);
app.use('/api/v1/platform/packages', platformPackageRoutes);
app.use('/api/v1/catalog/packages', publicPackageRoutes);
app.use('/api/v1/applications', publicApplicationRoutes);
app.use('/api/v1/platform/applications', platformApplicationRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/appointments', appointmentsRoutes);
app.use('/api/v1/medications', medicationsRoutes);
app.use('/api/v1/vitals', vitalsRoutes);
app.use('/api/v1/health-metrics', healthMetricsRoutes);
app.use('/api/v1/medical-records', medicalRecordsRoutes);
app.use('/api/v1/family-care', familyCareRoutes);
app.use('/api/v1/professionals', professionalRoutes);
app.use('/api/v1/doctor-care', doctorCareRoutes);
app.use('/api/v1/prescriptions', prescriptionRoutes);
app.use('/api/v1/pharmacies', pharmacyRoutes);
app.use('/api/v1/pharmacies', discoveryRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/pharmacy-requests', pharmacyRequestRoutes);
app.use('/api/v1/reservations', reservationRoutes);
app.use('/api/v1/checkout-pricing', checkoutPricingRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1', paymentRoutes);
app.use('/api/v1/fulfilments', fulfilmentRoutes);
app.use('/api/v1/delivery', deliveryRoutes);

// --- GLOBAL ERROR HANDLING ---
app.use(notFound);
app.use(errorHandler);
