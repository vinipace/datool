import * as migration_20260917_065611 from './20260917_065611';
import * as migration_20260917_114834_faq_answer_pages from './20260917_114834_faq_answer_pages';

export const migrations = [
  {
    up: migration_20260917_065611.up,
    down: migration_20260917_065611.down,
    name: '20260917_065611',
  },
  {
    up: migration_20260917_114834_faq_answer_pages.up,
    down: migration_20260917_114834_faq_answer_pages.down,
    name: '20260917_114834_faq_answer_pages'
  },
];
