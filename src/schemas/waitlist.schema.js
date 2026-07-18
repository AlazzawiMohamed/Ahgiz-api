const { z, uuid } = require('./common');

// DELETE /waitlist/:id — validate the route param as a UUID.
// Applied inside the controller via safeParse, because the shared `validate`
// middleware only parses req.body (not req.params).
const remove = z.object({
  id: uuid,
});

module.exports = { remove };
