import * as migration_20260917_065611 from "./20260917_065611"
import * as migration_20260917_114834_faq_answer_pages from "./20260917_114834_faq_answer_pages"
import * as migration_20261013_025034_cms_auth_reset_request from "./20261013_025034_cms_auth_reset_request"
import * as migration_20261027_115532_agent_landings from "./20261027_115532_agent_landings"
import * as migration_20261028_035632_feature_item_links from "./20261028_035632_feature_item_links"
import * as migration_20261028_135919_agent_landing_faqs from "./20261028_135919_agent_landing_faqs"

export const migrations = [
  {
    up: migration_20260917_065611.up,
    down: migration_20260917_065611.down,
    name: "20260917_065611",
  },
  {
    up: migration_20260917_114834_faq_answer_pages.up,
    down: migration_20260917_114834_faq_answer_pages.down,
    name: "20260917_114834_faq_answer_pages",
  },
  {
    up: migration_20261013_025034_cms_auth_reset_request.up,
    down: migration_20261013_025034_cms_auth_reset_request.down,
    name: "20261013_025034_cms_auth_reset_request",
  },
  {
    up: migration_20261027_115532_agent_landings.up,
    down: migration_20261027_115532_agent_landings.down,
    name: "20261027_115532_agent_landings",
  },
  {
    up: migration_20261028_035632_feature_item_links.up,
    down: migration_20261028_035632_feature_item_links.down,
    name: "20261028_035632_feature_item_links",
  },
  {
    up: migration_20261028_135919_agent_landing_faqs.up,
    down: migration_20261028_135919_agent_landing_faqs.down,
    name: "20261028_135919_agent_landing_faqs",
  },
]
