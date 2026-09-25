import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";
import express from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";

const specificationPath = fileURLToPath(
  new URL("../../docs/openapi.yaml", import.meta.url),
);
const specification = YAML.parse(fs.readFileSync(specificationPath, "utf8"));
const router = express.Router();

router.get("/openapi.json", (req, res) => res.json(specification));
const renderSwagger = swaggerUi.setup(specification, {
  customSiteTitle: "Sabi Health Backend API",
  swaggerOptions: { persistAuthorization: false, displayRequestDuration: true },
});
router.use("/docs", swaggerUi.serve);
router.get("/docs", (req, res, next) => {
  if (!req.originalUrl.endsWith("/")) {
    return res.redirect(301, `${req.originalUrl}/`);
  }
  return renderSwagger(req, res, next);
});
router.get("/docs/", renderSwagger);

export { specification };
export default router;
