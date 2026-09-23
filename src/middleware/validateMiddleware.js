// Validates req.body/query/params against a Zod schema before the controller runs.
// Uses safeParse so we never throw here, and reads `error.issues` — the Zod 4
// field (Zod 3's `error.errors` alias was removed, which previously turned every
// validation failure into a 500 with no field details).
export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (result.success) {
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.query !== undefined) req.query = result.data.query;
    if (result.data.params !== undefined) req.params = result.data.params;
    return next();
  }

  return res.status(400).json({
    status: 'error',
    message: 'Invalid input data',
    errors: result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  });
};
