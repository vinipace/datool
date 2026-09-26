import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload"."faqs" ADD COLUMN "short_answer" varchar;
  ALTER TABLE "payload"."faqs" ADD COLUMN "seo_title" varchar;
  ALTER TABLE "payload"."faqs" ADD COLUMN "seo_description" varchar;
  ALTER TABLE "payload"."faqs" ADD COLUMN "seo_no_index" boolean DEFAULT false;
  ALTER TABLE "payload"."_faqs_v" ADD COLUMN "version_short_answer" varchar;
  ALTER TABLE "payload"."_faqs_v" ADD COLUMN "version_seo_title" varchar;
  ALTER TABLE "payload"."_faqs_v" ADD COLUMN "version_seo_description" varchar;
  ALTER TABLE "payload"."_faqs_v" ADD COLUMN "version_seo_no_index" boolean DEFAULT false;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload"."faqs" DROP COLUMN "short_answer";
  ALTER TABLE "payload"."faqs" DROP COLUMN "seo_title";
  ALTER TABLE "payload"."faqs" DROP COLUMN "seo_description";
  ALTER TABLE "payload"."faqs" DROP COLUMN "seo_no_index";
  ALTER TABLE "payload"."_faqs_v" DROP COLUMN "version_short_answer";
  ALTER TABLE "payload"."_faqs_v" DROP COLUMN "version_seo_title";
  ALTER TABLE "payload"."_faqs_v" DROP COLUMN "version_seo_description";
  ALTER TABLE "payload"."_faqs_v" DROP COLUMN "version_seo_no_index";`)
}
