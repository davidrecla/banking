import { jsonResponse, errorResponse } from '../lib/auth.js';
import { recordAndNotify } from '../lib/activity.js';

/**
 * GET /api/cards — the caller's cards.
 *
 * Only masked values exist in the database; there is no real PAN or CVV behind
 * them. Phase 4 must not add an endpoint that "unmasks" a card, because there
 * is nothing to unmask — if a card-data-exposure vulnerability is wanted for
 * the demo, generate obviously-fake full numbers at that point rather than
 * storing them here.
 */
export async function handleGetCards(request, env, auth) {
  const { results } = await env.BANK_DB
    .prepare(
      `SELECT c.id, c.card_type, c.card_number_masked, c.card_holder, c.expiry,
              c.cvv_masked, c.status, c.blocked_at, c.created_at,
              a.account_type, a.account_number
         FROM cards c
         JOIN accounts a ON a.id = c.linked_account_id
        WHERE c.user_id = ?
        ORDER BY c.card_type, c.created_at`
    )
    .bind(auth.sub)
    .all();

  return jsonResponse({ cards: results });
}

/** POST /api/cards/:id/block */
export async function handleBlockCard(request, env, auth, cardId) {
  return setCardStatus(request, env, auth, cardId, 'blocked');
}

/** POST /api/cards/:id/unblock */
export async function handleUnblockCard(request, env, auth, cardId) {
  return setCardStatus(request, env, auth, cardId, 'active');
}

async function setCardStatus(request, env, auth, cardId, status) {
  const card = await env.BANK_DB
    .prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?')
    .bind(cardId, auth.sub)
    .first();
  if (!card) return errorResponse('Card not found', 404);

  if (card.status === status) {
    return errorResponse(
      status === 'blocked' ? 'Card is already blocked' : 'Card is already active',
      400
    );
  }

  const now = new Date().toISOString();
  await env.BANK_DB
    .prepare('UPDATE cards SET status = ?, blocked_at = ? WHERE id = ?')
    .bind(status, status === 'blocked' ? now : null, cardId)
    .run();

  const blocked = status === 'blocked';
  await recordAndNotify(
    env,
    request,
    auth.sub,
    blocked ? 'card_block' : 'card_unblock',
    `${blocked ? 'Blocked' : 'Unblocked'} ${card.card_type} card ${card.card_number_masked}`,
    {
      type: 'security',
      title: blocked ? 'Card blocked' : 'Card unblocked',
      message: `Your ${card.card_type} card ending ${card.card_number_masked.slice(-4)} is now ${blocked ? 'blocked' : 'active'}.`
    }
  );

  return jsonResponse({
    message: blocked ? 'Card blocked' : 'Card unblocked',
    card: { id: cardId, status, blockedAt: blocked ? now : null }
  });
}
