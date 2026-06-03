import { peopleView } from './_people.js';

const view = peopleView({ endpoint: 'owners', titre: 'Propriétaires', singular: 'propriétaire' });
export const render = view.render;
