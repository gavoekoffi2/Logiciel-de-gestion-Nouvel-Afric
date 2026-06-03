import { peopleView } from './_people.js';

const view = peopleView({ endpoint: 'tenants', titre: 'Locataires', singular: 'locataire' });
export const render = view.render;
