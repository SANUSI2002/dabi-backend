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
import { startExpiryRunner, stopExpiryRunner } from './modules/reservations/reservation.expiry.js';
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
import { privateStorageClient } from './config/privateStorage.js';
import { checkOrProvisionBuckets } from './config/supabaseBuckets.js';
import { startEvidenceScanner } from './modules/platform/platform.evidence-scanner.js';

const app = express();
app.set('trust proxy', trustedProxySetting());
warnRateLimitFallback();

// --- SECURITY PROTOCOLS ---
app.use(helmet());

app.use(cors({
  origin: (process.env.CLIENT_URLS || process.env.CLIENT_URL || 'http://localhost:5173').split(',').map((url) => url.trim()).filter(Boolean),
  credentials: true,
}));

app.use('/api/', globalLimiter);

app.post('/api/v1/payments/paystack/webhook', paystackWebhook, paymentController.webhook);

// Private onboarding documents have a bounded parser before the default 100 KiB parser.
app.use('/api/v1/organisations', organisationRoutes);
app.use(express.json());

// --- MODULAR BUCKET ROUTING ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'success', message: 'Sabi Health backend is running securely' });
});

app.use('/api/v1/hospitals', hospitalPlanRoutes);
app.use('/api/v1', caregiverRoutes);
app.use('/api/v1/auth', authRoutes);
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

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`--Sabi Health backend securely running on port ${PORT}`);
});
// A read-only preflight verifies bucket privacy after deployment. It never
// creates buckets, logs credentials, or changes the application's DB target.
if (process.env.SUPABASE_URL || process.env.SUPABASE_SECRET_KEY) {
  Promise.resolve().then(() => checkOrProvisionBuckets(privateStorageClient())).then((buckets) => {
    const ready = buckets.filter((bucket) => bucket.state === 'READY').length;
    console.log(`[storage] ${ready}/${buckets.length} private buckets ready`);
  }).catch((error) => {
    console.error(`[storage] private bucket preflight failed: ${error.code ?? 'UNKNOWN_ERROR'}`);
  });
}
startExpiryRunner();
const stopEvidenceScanner = startEvidenceScanner();
const shutdown = () => { stopEvidenceScanner(); stopExpiryRunner(); server.close(() => process.exit(0)); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
