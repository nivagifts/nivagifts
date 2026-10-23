﻿app.post("/api/gifts", requireAuthenticated, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { templateId, envelope } = req.body || {};

    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      return res.status(400).json({ success: false, message: "Unsupported gift template." });
    }
    if (!validateEncryptedEnvelope(envelope)) {
      return res.status(400).json({ success: false, message: "Invalid encrypted gift payload." });
    }

    const expectedPrice = TEMPLATE_PRICES[templateId];
    if (!expectedPrice) {
      return res.status(400).json({ success: false, message: "Unknown template price." });
    }

    const encryptedPayload = Buffer.from(JSON.stringify(envelope), "utf8");
    if (encryptedPayload.length > MAX_ENVELOPE_BYTES) {
      return res.status(413).json({ success: false, message: "The encrypted gift is too large." });
    }

    const publicId = crypto.randomBytes(24).toString("base64url");

    const result = await client.query(
      `INSERT INTO app.gifts
        (owner_user_id, public_id, template_id, status,
         encrypted_payload, gift_password_hash,
         created_at, updated_at, published_at,
         paid, amount_inr, payment_id, published)
       VALUES ($1, $2, $3, 'published', $4, NULL, NOW(), NOW(), NOW(),
               FALSE, $5, NULL, TRUE)
       RETURNING public_id, template_id, status, created_at`,
      [req.session.userId, publicId, templateId, encryptedPayload, expectedPrice]
    );

    const gift = result.rows[0];

    await client.query(
      `DELETE FROM app.drafts WHERE user_id = $1 AND template_id = $2`,
      [req.session.userId, templateId]
    );

    res.status(201).json({
      success: true,
      gift: {
        publicId: gift.public_id,
        templateId: gift.template_id,
        status: gift.status,
        createdAt: gift.created_at,
        url: "/g/" + gift.public_id,
      },
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});