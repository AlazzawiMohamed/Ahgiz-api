const { ZodError } = require('zod');

// Reusable validation middleware.
//
// Parses req.body against the given Zod schema. On success the parsed result
// (unknown keys stripped, strings trimmed, values coerced per the schema)
// replaces req.body, so controllers receive only declared, validated fields.
//
// On a ZodError we respond 400 with field-level details. NOTE: zod v4 exposes the
// issue list on `err.issues` (zod v3 used `err.errors`); we read whichever exists
// so the same middleware works on both.
module.exports = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
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
