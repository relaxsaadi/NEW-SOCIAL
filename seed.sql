-- Seed data for development/testing

-- Test user
INSERT OR IGNORE INTO users (id, email, created_at, locale, source) VALUES
  ('01TEST_USER_01', 'demo@example.com', strftime('%s', 'now'), 'fr', 'demo');

-- Test analyses
INSERT OR IGNORE INTO analyses (id, user_id, offer_type, mode, context_type, status, input_text, created_at, updated_at)
VALUES
  ('01TEST_ANALYSIS_COMPLETED', '01TEST_USER_01', 'deep_read', 'dating_decode', 'dating', 'completed',
   'Il m a repondu Ok. apres 3 jours de silence alors qu on se parlait tous les jours.',
   strftime('%s', 'now'), strftime('%s', 'now')),
  ('01TEST_ANALYSIS_PENDING', '01TEST_USER_01', 'quick_decode', 'message_decode', 'work', 'paid',
   NULL, strftime('%s', 'now'), strftime('%s', 'now'));

-- Update completed analysis with mock result
UPDATE analyses SET ai_result_json = '{
  "summary": "Les signaux indiquent un désengagement progressif. La combinaison du délai de 3 jours et de la réponse minimaliste \"Ok.\" constituent un signal de distance claire.",
  "observable_signals": [
    {"signal": "Délai de réponse de 3 jours", "type": "timing", "interpretation": "Rupture de pattern — la personne ne priorise plus la communication"},
    {"signal": "Réponse d'\''un seul mot : Ok.", "type": "content", "interpretation": "Investissement minimal, fermeture conversationnelle"},
    {"signal": "Contraste avec habitude de parler quotidiennement", "type": "pattern", "interpretation": "Changement comportemental significatif"}
  ],
  "main_reading": {
    "title": "Désengagement progressif",
    "description": "La combinaison délai + monosyllabe représente un signal de retrait fort. Cette personne gère soit une situation externe difficile, soit réduit intentionnellement l'\''investissement émotionnel.",
    "probability_score": 78
  },
  "alternative_readings": [
    {"title": "Épuisement / Surcharge externe", "description": "Peut être temporairement dépassée par des obligations personnelles ou professionnelles.", "probability_score": 15},
    {"title": "Test de réaction", "description": "Certaines personnes testent inconsciemment la réaction de l'\''autre face au silence.", "probability_score": 7}
  ],
  "scores": {
    "interest": 22,
    "clarity": 85,
    "respect": 40,
    "effort": 8,
    "manipulation_risk": 12
  },
  "best_next_action": {
    "action": "Ne rien faire / Observer",
    "rationale": "Ne pas récompenser le faible effort par de l'\''effort élevé. Attendre de voir si la personne relance. Votre valeur perçue se préserve en mirant ce niveau d'\''investissement."
  },
  "reply_options": [
    {"style": "Soft", "text": "Tout va bien de ton côté ?", "why_it_works": "Ouvre une porte sans pression, montre de l'\''attention sans demander de comptes."},
    {"style": "Direct", "text": "Je remarque qu'\''on est moins en contact — c'\''est voulu ?", "why_it_works": "Crée la clarté sans agressivité. Force une réponse honnête."},
    {"style": "Detached", "text": null, "why_it_works": "Répondre à ce niveau : ne pas répondre du tout, ou attendre la prochaine initiative de leur part."}
  ],
  "uncertainties": [
    "Contexte externe inconnu (stress, maladie, problème perso)",
    "Historique complet de la relation non disponible",
    "Ton habituel de la personne par message non précisé"
  ],
  "safety_note": null,
  "status": "ok"
}', confidence_score = 0.78 WHERE id = '01TEST_ANALYSIS_COMPLETED';

-- Test payment
INSERT OR IGNORE INTO payments (id, analysis_id, user_id, stripe_session_id, amount_cents, status, offer_type, created_at, updated_at)
VALUES
  ('01TEST_PAYMENT_01', '01TEST_ANALYSIS_COMPLETED', '01TEST_USER_01', 'cs_test_demo', 2900, 'paid', 'deep_read', strftime('%s', 'now'), strftime('%s', 'now'));
