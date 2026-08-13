'use strict';

/**
 * Robustesse de l'interface : ces défauts ne cassaient pas un écran d'un coup,
 * ils se manifestaient après quelques heures d'utilisation — écouteurs clavier
 * accumulés, promesses jamais résolues, erreurs serveur invisibles.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const core = read('public/js/core.js');

test('a single shared key listener drives the modal stack', () => {
  // Un écouteur par modale s'accumulait sur le document et une seule touche
  // Échap fermait toutes les modales empilées.
  assert.match(core, /const modalStack = \[\]/);
  assert.match(core, /modalStack\[modalStack\.length - 1\]\.close\(\)/);
  assert.doesNotMatch(core, /document\.addEventListener\('keydown', function esc/);
});

test('closing a modal any way resolves the caller instead of hanging', () => {
  assert.match(core, /export function openModal\(innerHtml, \{ size = '', onClose \} = \{\}\)/);
  assert.match(core, /if \(onClose\) onClose\(\)/);
  // confirmDialog et formModal branchent bien onClose.
  assert.match(core, /onClose: \(\) => resolve\(false\)/);
  assert.match(core, /onClose: \(\) => resolve\(null\)/);
});

test('a modal never closes twice or leaves its entry in the stack', () => {
  assert.match(core, /if \(closed\) return;/);
  assert.match(core, /modalStack\.splice\(index, 1\)/);
});

test('confirmation messages keep their line breaks', () => {
  assert.match(core, /escapeHtml\(message\)\.replace\(\/\\n\/g, '<br>'\)/);
});

test('every destructive action surfaces the server error to the user', () => {
  const views = ['locataires', 'souscriptions', '_people', 'reglements', 'reversements', 'maisonDetail', 'recouvrement'];
  for (const name of views) {
    const source = read(`public/js/views/${name}.js`);
    const deletions = source.match(/await api\.del\([^)]*\)/g) || [];
    for (const call of deletions) {
      const index = source.indexOf(call);
      const before = source.slice(Math.max(0, index - 400), index);
      assert.match(before, /try \{/,
        `${name}.js : « ${call} » n'est pas protégé, l'échec resterait invisible pour l'utilisateur`);
    }
  }
});

test('the payout screen reverses exactly the rents it displayed', () => {
  const payouts = read('public/js/views/reversements.js');
  assert.match(payouts, /payment_ids: data\.lignes\.map\(\(l\) => l\.id\)/);
});
