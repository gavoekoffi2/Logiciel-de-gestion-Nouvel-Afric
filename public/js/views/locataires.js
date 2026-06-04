import { peopleView } from './_people.js';
import { fmt } from '../core.js';

const view = peopleView({
  endpoint: 'tenants', titre: 'Locataires', singular: 'locataire',
  extraFields: [
    { name: 'caution', label: 'Caution (FCFA)', type: 'number', min: 0, step: 1000 },
  ],
  extraColumns: [
    { label: 'Caution', num: true, render: (r) => fmt.money(r.caution || 0) },
  ],
});
export const render = view.render;
