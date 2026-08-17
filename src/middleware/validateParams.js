const { ZodError } = require('zod');

// Reusable ROUTE-PARAM validation middleware — the req.params counterpart to
// validate.js (which parses req.body).
//
// Unlike validate.js this does NOT assign the parsed result back onto the request.
// Express re-derives req.params for each matched router layer, so a reassignment
// here is not guaranteed to survive to the controller. Every param schema in this
// project is shape-only (the shared `uuid` helper is a plain regex with no
// transform), so validate-and-reject is sufficient and controllers keep reading
// req.params directly.
//
// The 400 response shape is identical to validate.js so clients handle one format.
module.exports = (schema) => (req, res, next) => {
  try {
    schema.parse(req.params);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues || err.errors || [];
      return res.status(400).json({
        error: 'validation_error',
        message: 'Invalid request data',
        fields: issues.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
    }
    next(err);
  }
};
