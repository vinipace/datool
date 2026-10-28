import { MigrateUpArgs, MigrateDownArgs, sql } from "@payloadcms/db-postgres"

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload"."pages_blocks_features_items" ADD COLUMN "href" varchar;
  ALTER TABLE "payload"."_pages_v_blocks_features_items" ADD COLUMN "href" varchar;
  ALTER TABLE "payload"."landing_page_blocks_features_items" ADD COLUMN "href" varchar;
  ALTER TABLE "payload"."_landing_page_v_blocks_features_items" ADD COLUMN "href" varchar;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload"."pages_blocks_features_items" DROP COLUMN "href";
  ALTER TABLE "payload"."_pages_v_blocks_features_items" DROP COLUMN "href";
  ALTER TABLE "payload"."landing_page_blocks_features_items" DROP COLUMN "href";
  ALTER TABLE "payload"."_landing_page_v_blocks_features_items" DROP COLUMN "href";`)
}
