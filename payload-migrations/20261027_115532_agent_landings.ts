import { MigrateUpArgs, MigrateDownArgs, sql } from "@payloadcms/db-postgres"

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "payload"."enum_agent_lp_story_chapters_messages_from" AS ENUM('customer', 'agent', 'human', 'event');
  CREATE TYPE "payload"."enum_agent_lp_story_products_tone" AS ENUM('leaf', 'lilac', 'peach');
  CREATE TYPE "payload"."enum_agent_lp_features_items_visual" AS ENUM('whatsapp', 'website', 'inproduct', 'spotlight', 'catalog', 'handoff', 'knowledge', 'actions', 'widgets', 'leads', 'campaigns', 'guardrails', 'analytics');
  CREATE TYPE "payload"."enum_agent_lp_features_items_size" AS ENUM('regular', 'wide', 'large');
  CREATE TYPE "payload"."enum_agent_lp_channel" AS ENUM('web', 'whatsapp', 'app');
  CREATE TYPE "payload"."enum_agent_lp_status" AS ENUM('draft', 'published');
  CREATE TYPE "payload"."enum__agent_lp_v_version_story_chapters_messages_from" AS ENUM('customer', 'agent', 'human', 'event');
  CREATE TYPE "payload"."enum__agent_lp_v_version_story_products_tone" AS ENUM('leaf', 'lilac', 'peach');
  CREATE TYPE "payload"."enum__agent_lp_v_version_features_items_visual" AS ENUM('whatsapp', 'website', 'inproduct', 'spotlight', 'catalog', 'handoff', 'knowledge', 'actions', 'widgets', 'leads', 'campaigns', 'guardrails', 'analytics');
  CREATE TYPE "payload"."enum__agent_lp_v_version_features_items_size" AS ENUM('regular', 'wide', 'large');
  CREATE TYPE "payload"."enum__agent_lp_v_version_channel" AS ENUM('web', 'whatsapp', 'app');
  CREATE TYPE "payload"."enum__agent_lp_v_version_status" AS ENUM('draft', 'published');
  CREATE TABLE "payload"."agent_lp_story_chapters_messages" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"from" "payload"."enum_agent_lp_story_chapters_messages_from" DEFAULT 'customer',
  	"text" varchar,
  	"show_products" boolean DEFAULT false,
  	"highlight" boolean DEFAULT false
  );
  
  CREATE TABLE "payload"."agent_lp_story_chapters" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"time" varchar,
  	"title" varchar,
  	"text" varchar
  );
  
  CREATE TABLE "payload"."agent_lp_story_products" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"price" varchar,
  	"tone" "payload"."enum_agent_lp_story_products_tone" DEFAULT 'leaf'
  );
  
  CREATE TABLE "payload"."agent_lp_features_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"text" varchar,
  	"visual" "payload"."enum_agent_lp_features_items_visual",
  	"size" "payload"."enum_agent_lp_features_items_size" DEFAULT 'regular'
  );
  
  CREATE TABLE "payload"."agent_lp_faq_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"question" varchar,
  	"answer" varchar
  );
  
  CREATE TABLE "payload"."agent_lp" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"slug" varchar,
  	"channel" "payload"."enum_agent_lp_channel" DEFAULT 'web',
  	"whatsapp_number" varchar,
  	"whatsapp_message" varchar,
  	"hero_title" varchar,
  	"hero_accent" varchar,
  	"hero_description" varchar,
  	"hero_primary_label" varchar,
  	"hero_scroll_label" varchar,
  	"story_contact" varchar,
  	"story_assistant" varchar,
  	"story_site" varchar,
  	"features_title" varchar,
  	"features_accent" varchar,
  	"faq_title" varchar,
  	"cta_title" varchar,
  	"cta_description" varchar,
  	"cta_label" varchar,
  	"seo_title" varchar,
  	"seo_description" varchar,
  	"seo_no_index" boolean DEFAULT false,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "payload"."enum_agent_lp_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "payload"."_agent_lp_v_version_story_chapters_messages" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"from" "payload"."enum__agent_lp_v_version_story_chapters_messages_from" DEFAULT 'customer',
  	"text" varchar,
  	"show_products" boolean DEFAULT false,
  	"highlight" boolean DEFAULT false,
  	"_uuid" varchar
  );
  
  CREATE TABLE "payload"."_agent_lp_v_version_story_chapters" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"time" varchar,
  	"title" varchar,
  	"text" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "payload"."_agent_lp_v_version_story_products" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"price" varchar,
  	"tone" "payload"."enum__agent_lp_v_version_story_products_tone" DEFAULT 'leaf',
  	"_uuid" varchar
  );
  
  CREATE TABLE "payload"."_agent_lp_v_version_features_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"text" varchar,
  	"visual" "payload"."enum__agent_lp_v_version_features_items_visual",
  	"size" "payload"."enum__agent_lp_v_version_features_items_size" DEFAULT 'regular',
  	"_uuid" varchar
  );
  
  CREATE TABLE "payload"."_agent_lp_v_version_faq_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"question" varchar,
  	"answer" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "payload"."_agent_lp_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_title" varchar,
  	"version_slug" varchar,
  	"version_channel" "payload"."enum__agent_lp_v_version_channel" DEFAULT 'web',
  	"version_whatsapp_number" varchar,
  	"version_whatsapp_message" varchar,
  	"version_hero_title" varchar,
  	"version_hero_accent" varchar,
  	"version_hero_description" varchar,
  	"version_hero_primary_label" varchar,
  	"version_hero_scroll_label" varchar,
  	"version_story_contact" varchar,
  	"version_story_assistant" varchar,
  	"version_story_site" varchar,
  	"version_features_title" varchar,
  	"version_features_accent" varchar,
  	"version_faq_title" varchar,
  	"version_cta_title" varchar,
  	"version_cta_description" varchar,
  	"version_cta_label" varchar,
  	"version_seo_title" varchar,
  	"version_seo_description" varchar,
  	"version_seo_no_index" boolean DEFAULT false,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "payload"."enum__agent_lp_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean,
  	"autosave" boolean
  );
  
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD COLUMN "agent_lp_id" integer;
  ALTER TABLE "payload"."agent_lp_story_chapters_messages" ADD CONSTRAINT "agent_lp_story_chapters_messages_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."agent_lp_story_chapters"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."agent_lp_story_chapters" ADD CONSTRAINT "agent_lp_story_chapters_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."agent_lp"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."agent_lp_story_products" ADD CONSTRAINT "agent_lp_story_products_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."agent_lp"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."agent_lp_features_items" ADD CONSTRAINT "agent_lp_features_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."agent_lp"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."agent_lp_faq_items" ADD CONSTRAINT "agent_lp_faq_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."agent_lp"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v_version_story_chapters_messages" ADD CONSTRAINT "_agent_lp_v_version_story_chapters_messages_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_agent_lp_v_version_story_chapters"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v_version_story_chapters" ADD CONSTRAINT "_agent_lp_v_version_story_chapters_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_agent_lp_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v_version_story_products" ADD CONSTRAINT "_agent_lp_v_version_story_products_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_agent_lp_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v_version_features_items" ADD CONSTRAINT "_agent_lp_v_version_features_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_agent_lp_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v_version_faq_items" ADD CONSTRAINT "_agent_lp_v_version_faq_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_agent_lp_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v" ADD CONSTRAINT "_agent_lp_v_parent_id_agent_lp_id_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."agent_lp"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "agent_lp_story_chapters_messages_order_idx" ON "payload"."agent_lp_story_chapters_messages" USING btree ("_order");
  CREATE INDEX "agent_lp_story_chapters_messages_parent_id_idx" ON "payload"."agent_lp_story_chapters_messages" USING btree ("_parent_id");
  CREATE INDEX "agent_lp_story_chapters_order_idx" ON "payload"."agent_lp_story_chapters" USING btree ("_order");
  CREATE INDEX "agent_lp_story_chapters_parent_id_idx" ON "payload"."agent_lp_story_chapters" USING btree ("_parent_id");
  CREATE INDEX "agent_lp_story_products_order_idx" ON "payload"."agent_lp_story_products" USING btree ("_order");
  CREATE INDEX "agent_lp_story_products_parent_id_idx" ON "payload"."agent_lp_story_products" USING btree ("_parent_id");
  CREATE INDEX "agent_lp_features_items_order_idx" ON "payload"."agent_lp_features_items" USING btree ("_order");
  CREATE INDEX "agent_lp_features_items_parent_id_idx" ON "payload"."agent_lp_features_items" USING btree ("_parent_id");
  CREATE INDEX "agent_lp_faq_items_order_idx" ON "payload"."agent_lp_faq_items" USING btree ("_order");
  CREATE INDEX "agent_lp_faq_items_parent_id_idx" ON "payload"."agent_lp_faq_items" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "agent_lp_slug_idx" ON "payload"."agent_lp" USING btree ("slug");
  CREATE INDEX "agent_lp_updated_at_idx" ON "payload"."agent_lp" USING btree ("updated_at");
  CREATE INDEX "agent_lp_created_at_idx" ON "payload"."agent_lp" USING btree ("created_at");
  CREATE INDEX "agent_lp__status_idx" ON "payload"."agent_lp" USING btree ("_status");
  CREATE INDEX "_agent_lp_v_version_story_chapters_messages_order_idx" ON "payload"."_agent_lp_v_version_story_chapters_messages" USING btree ("_order");
  CREATE INDEX "_agent_lp_v_version_story_chapters_messages_parent_id_idx" ON "payload"."_agent_lp_v_version_story_chapters_messages" USING btree ("_parent_id");
  CREATE INDEX "_agent_lp_v_version_story_chapters_order_idx" ON "payload"."_agent_lp_v_version_story_chapters" USING btree ("_order");
  CREATE INDEX "_agent_lp_v_version_story_chapters_parent_id_idx" ON "payload"."_agent_lp_v_version_story_chapters" USING btree ("_parent_id");
  CREATE INDEX "_agent_lp_v_version_story_products_order_idx" ON "payload"."_agent_lp_v_version_story_products" USING btree ("_order");
  CREATE INDEX "_agent_lp_v_version_story_products_parent_id_idx" ON "payload"."_agent_lp_v_version_story_products" USING btree ("_parent_id");
  CREATE INDEX "_agent_lp_v_version_features_items_order_idx" ON "payload"."_agent_lp_v_version_features_items" USING btree ("_order");
  CREATE INDEX "_agent_lp_v_version_features_items_parent_id_idx" ON "payload"."_agent_lp_v_version_features_items" USING btree ("_parent_id");
  CREATE INDEX "_agent_lp_v_version_faq_items_order_idx" ON "payload"."_agent_lp_v_version_faq_items" USING btree ("_order");
  CREATE INDEX "_agent_lp_v_version_faq_items_parent_id_idx" ON "payload"."_agent_lp_v_version_faq_items" USING btree ("_parent_id");
  CREATE INDEX "_agent_lp_v_parent_idx" ON "payload"."_agent_lp_v" USING btree ("parent_id");
  CREATE INDEX "_agent_lp_v_version_version_slug_idx" ON "payload"."_agent_lp_v" USING btree ("version_slug");
  CREATE INDEX "_agent_lp_v_version_version_updated_at_idx" ON "payload"."_agent_lp_v" USING btree ("version_updated_at");
  CREATE INDEX "_agent_lp_v_version_version_created_at_idx" ON "payload"."_agent_lp_v" USING btree ("version_created_at");
  CREATE INDEX "_agent_lp_v_version_version__status_idx" ON "payload"."_agent_lp_v" USING btree ("version__status");
  CREATE INDEX "_agent_lp_v_created_at_idx" ON "payload"."_agent_lp_v" USING btree ("created_at");
  CREATE INDEX "_agent_lp_v_updated_at_idx" ON "payload"."_agent_lp_v" USING btree ("updated_at");
  CREATE INDEX "_agent_lp_v_latest_idx" ON "payload"."_agent_lp_v" USING btree ("latest");
  CREATE INDEX "_agent_lp_v_autosave_idx" ON "payload"."_agent_lp_v" USING btree ("autosave");
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_agent_landings_fk" FOREIGN KEY ("agent_lp_id") REFERENCES "payload"."agent_lp"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_agent_lp_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("agent_lp_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload"."agent_lp_story_chapters_messages" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."agent_lp_story_chapters" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."agent_lp_story_products" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."agent_lp_features_items" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."agent_lp_faq_items" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."agent_lp" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."_agent_lp_v_version_story_chapters_messages" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."_agent_lp_v_version_story_chapters" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."_agent_lp_v_version_story_products" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."_agent_lp_v_version_features_items" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."_agent_lp_v_version_faq_items" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."_agent_lp_v" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "payload"."agent_lp_story_chapters_messages" CASCADE;
  DROP TABLE "payload"."agent_lp_story_chapters" CASCADE;
  DROP TABLE "payload"."agent_lp_story_products" CASCADE;
  DROP TABLE "payload"."agent_lp_features_items" CASCADE;
  DROP TABLE "payload"."agent_lp_faq_items" CASCADE;
  DROP TABLE "payload"."agent_lp" CASCADE;
  DROP TABLE "payload"."_agent_lp_v_version_story_chapters_messages" CASCADE;
  DROP TABLE "payload"."_agent_lp_v_version_story_chapters" CASCADE;
  DROP TABLE "payload"."_agent_lp_v_version_story_products" CASCADE;
  DROP TABLE "payload"."_agent_lp_v_version_features_items" CASCADE;
  DROP TABLE "payload"."_agent_lp_v_version_faq_items" CASCADE;
  DROP TABLE "payload"."_agent_lp_v" CASCADE;
  ALTER TABLE "payload"."payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_agent_landings_fk";
  
  DROP INDEX "payload"."payload_locked_documents_rels_agent_lp_id_idx";
  ALTER TABLE "payload"."payload_locked_documents_rels" DROP COLUMN "agent_lp_id";
  DROP TYPE "payload"."enum_agent_lp_story_chapters_messages_from";
  DROP TYPE "payload"."enum_agent_lp_story_products_tone";
  DROP TYPE "payload"."enum_agent_lp_features_items_visual";
  DROP TYPE "payload"."enum_agent_lp_features_items_size";
  DROP TYPE "payload"."enum_agent_lp_channel";
  DROP TYPE "payload"."enum_agent_lp_status";
  DROP TYPE "payload"."enum__agent_lp_v_version_story_chapters_messages_from";
  DROP TYPE "payload"."enum__agent_lp_v_version_story_products_tone";
  DROP TYPE "payload"."enum__agent_lp_v_version_features_items_visual";
  DROP TYPE "payload"."enum__agent_lp_v_version_features_items_size";
  DROP TYPE "payload"."enum__agent_lp_v_version_channel";
  DROP TYPE "payload"."enum__agent_lp_v_version_status";`)
}
