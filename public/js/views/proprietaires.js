import { peopleView } from './_people.js';
import { escapeHtml } from '../core.js';

const PIECES = ['Une pièce', 'Chambre salon', '2 chambres salon', '3 chambres salon', '4 chambres salon'];

const view = peopleView({
  endpoint: 'owners', titre: 'Propriétaires', singular: 'propriétaire',
  extraFields: [
    { name: 'type_logement', label: 'Type de logement', type: 'select', options: ['Villa', 'Appartement'] },
    { name: 'pieces_logement', label: 'Nombre de pièces', type: 'select', options: PIECES },
  ],
  extraColumns: [
    { label: 'Logement', render: (r) => escapeHtml([r.type_logement, r.pieces_logement].filter(Boolean).join(' · ') || '—') },
  ],
});
export const render = view.render;
