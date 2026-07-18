const { z, uuid, requiredShort } = require('./common');

// POST /payments/asiahawala/initiate
const asiahawalaInitiate = z.object({
  booking_id: uuid,
});

// POST /payments/asiahawala/submit
const asiahawalaSubmit = z.object({
  booking_id: uuid,
  hawala_reference: requiredShort,
});

module.exports = { asiahawalaInitiate, asiahawalaSubmit };
