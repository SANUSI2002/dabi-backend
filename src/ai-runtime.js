import { createAiGateway } from './modules/ai/ai.gateway-server.js';
const server = createAiGateway().listen(Number(process.env.PORT || 8080));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
