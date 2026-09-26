import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE SCHEMA IF NOT EXISTS "payload";
   CREATE TYPE "payload"."enum_pages_status" AS ENUM('draft', 'published');
  CREATE TYPE "payload"."enum__pages_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "payload"."enum_faqs_status" AS ENUM('draft', 'published');
  CREATE TYPE "payload"."enum__faqs_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "payload"."enum_landing_page_status" AS ENUM('draft', 'published');
  CREATE TYPE "payload"."enum__landing_page_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "payload"."enum_faq_page_status" AS ENUM('draft', 'published');
  CREATE TYPE "payload"."enum__faq_page_v_version_status" AS ENUM('draft', 'published');
  CREATE TABLE "payload"."cms_users_sessions" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "created_at" timestamp(3) with time zone,
    "expires_at" timestamp(3) with time zone NOT NULL
  );

  CREATE TABLE "payload"."cms_users" (
    "id" serial PRIMARY KEY NOT NULL,
    "auth_user_id" varchar NOT NULL,
    "name" varchar NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "email" varchar NOT NULL,
    "reset_password_token" varchar,
    "reset_password_expiration" timestamp(3) with time zone,
    "salt" varchar,
    "hash" varchar,
    "login_attempts" numeric DEFAULT 0,
    "lock_until" timestamp(3) with time zone
  );

  CREATE TABLE "payload"."pages_blocks_hero_actions" (
    "_order" integer NOT NULL,
    "_parent_id" varchar NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "label" varchar,
    "href" varchar
  );

  CREATE TABLE "payload"."pages_blocks_hero" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "eyebrow" varchar,
    "title" varchar,
    "description" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."pages_blocks_features_items" (
    "_order" integer NOT NULL,
    "_parent_id" varchar NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "title" varchar,
    "description" varchar
  );

  CREATE TABLE "payload"."pages_blocks_features" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "title" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."pages_blocks_rich_content" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "content" jsonb,
    "block_name" varchar
  );

  CREATE TABLE "payload"."pages_blocks_faq" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "title" varchar DEFAULT 'Frequently asked questions',
    "block_name" varchar
  );

  CREATE TABLE "payload"."pages_blocks_call_to_action" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "title" varchar,
    "description" varchar,
    "label" varchar,
    "href" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."pages" (
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "slug" varchar,
    "seo_title" varchar,
    "seo_description" varchar,
    "seo_no_index" boolean DEFAULT false,
    "published_at" timestamp(3) with time zone,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "_status" "payload"."enum_pages_status" DEFAULT 'draft'
  );

  CREATE TABLE "payload"."pages_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" integer NOT NULL,
    "path" varchar NOT NULL,
    "faqs_id" integer
  );

  CREATE TABLE "payload"."_pages_v_blocks_hero_actions" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "label" varchar,
    "href" varchar,
    "_uuid" varchar
  );

  CREATE TABLE "payload"."_pages_v_blocks_hero" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "eyebrow" varchar,
    "title" varchar,
    "description" varchar,
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_pages_v_blocks_features_items" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "description" varchar,
    "_uuid" varchar
  );

  CREATE TABLE "payload"."_pages_v_blocks_features" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_pages_v_blocks_rich_content" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "content" jsonb,
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_pages_v_blocks_faq" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar DEFAULT 'Frequently asked questions',
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_pages_v_blocks_call_to_action" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "description" varchar,
    "label" varchar,
    "href" varchar,
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_pages_v" (
    "id" serial PRIMARY KEY NOT NULL,
    "parent_id" integer,
    "version_title" varchar,
    "version_slug" varchar,
    "version_seo_title" varchar,
    "version_seo_description" varchar,
    "version_seo_no_index" boolean DEFAULT false,
    "version_published_at" timestamp(3) with time zone,
    "version_updated_at" timestamp(3) with time zone,
    "version_created_at" timestamp(3) with time zone,
    "version__status" "payload"."enum__pages_v_version_status" DEFAULT 'draft',
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "latest" boolean,
    "autosave" boolean
  );

  CREATE TABLE "payload"."_pages_v_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" integer NOT NULL,
    "path" varchar NOT NULL,
    "faqs_id" integer
  );

  CREATE TABLE "payload"."faqs" (
    "id" serial PRIMARY KEY NOT NULL,
    "question" varchar,
    "slug" varchar,
    "answer" jsonb,
    "order" numeric DEFAULT 0,
    "published_at" timestamp(3) with time zone,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "_status" "payload"."enum_faqs_status" DEFAULT 'draft'
  );

  CREATE TABLE "payload"."_faqs_v" (
    "id" serial PRIMARY KEY NOT NULL,
    "parent_id" integer,
    "version_question" varchar,
    "version_slug" varchar,
    "version_answer" jsonb,
    "version_order" numeric DEFAULT 0,
    "version_published_at" timestamp(3) with time zone,
    "version_updated_at" timestamp(3) with time zone,
    "version_created_at" timestamp(3) with time zone,
    "version__status" "payload"."enum__faqs_v_version_status" DEFAULT 'draft',
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "latest" boolean,
    "autosave" boolean
  );

  CREATE TABLE "payload"."payload_kv" (
    "id" serial PRIMARY KEY NOT NULL,
    "key" varchar NOT NULL,
    "data" jsonb NOT NULL
  );

  CREATE TABLE "payload"."payload_locked_documents" (
    "id" serial PRIMARY KEY NOT NULL,
    "global_slug" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload"."payload_locked_documents_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" integer NOT NULL,
    "path" varchar NOT NULL,
    "cms_users_id" integer,
    "pages_id" integer,
    "faqs_id" integer
  );

  CREATE TABLE "payload"."payload_preferences" (
    "id" serial PRIMARY KEY NOT NULL,
    "key" varchar,
    "value" jsonb,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload"."payload_preferences_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" integer NOT NULL,
    "path" varchar NOT NULL,
    "cms_users_id" integer
  );

  CREATE TABLE "payload"."payload_migrations" (
    "id" serial PRIMARY KEY NOT NULL,
    "name" varchar,
    "batch" numeric,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload"."landing_page_blocks_hero_actions" (
    "_order" integer NOT NULL,
    "_parent_id" varchar NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "label" varchar,
    "href" varchar
  );

  CREATE TABLE "payload"."landing_page_blocks_hero" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "eyebrow" varchar,
    "title" varchar,
    "description" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."landing_page_blocks_features_items" (
    "_order" integer NOT NULL,
    "_parent_id" varchar NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "title" varchar,
    "description" varchar
  );

  CREATE TABLE "payload"."landing_page_blocks_features" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "title" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."landing_page_blocks_rich_content" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "content" jsonb,
    "block_name" varchar
  );

  CREATE TABLE "payload"."landing_page_blocks_faq" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "title" varchar DEFAULT 'Frequently asked questions',
    "block_name" varchar
  );

  CREATE TABLE "payload"."landing_page_blocks_call_to_action" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "title" varchar,
    "description" varchar,
    "label" varchar,
    "href" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."landing_page" (
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "seo_title" varchar,
    "seo_description" varchar,
    "seo_no_index" boolean DEFAULT false,
    "_status" "payload"."enum_landing_page_status" DEFAULT 'draft',
    "updated_at" timestamp(3) with time zone,
    "created_at" timestamp(3) with time zone
  );

  CREATE TABLE "payload"."landing_page_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" integer NOT NULL,
    "path" varchar NOT NULL,
    "faqs_id" integer
  );

  CREATE TABLE "payload"."_landing_page_v_blocks_hero_actions" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "label" varchar,
    "href" varchar,
    "_uuid" varchar
  );

  CREATE TABLE "payload"."_landing_page_v_blocks_hero" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "eyebrow" varchar,
    "title" varchar,
    "description" varchar,
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_landing_page_v_blocks_features_items" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "description" varchar,
    "_uuid" varchar
  );

  CREATE TABLE "payload"."_landing_page_v_blocks_features" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_landing_page_v_blocks_rich_content" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "content" jsonb,
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_landing_page_v_blocks_faq" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar DEFAULT 'Frequently asked questions',
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_landing_page_v_blocks_call_to_action" (
    "_order" integer NOT NULL,
    "_parent_id" integer NOT NULL,
    "_path" text NOT NULL,
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "description" varchar,
    "label" varchar,
    "href" varchar,
    "_uuid" varchar,
    "block_name" varchar
  );

  CREATE TABLE "payload"."_landing_page_v" (
    "id" serial PRIMARY KEY NOT NULL,
    "version_title" varchar,
    "version_seo_title" varchar,
    "version_seo_description" varchar,
    "version_seo_no_index" boolean DEFAULT false,
    "version__status" "payload"."enum__landing_page_v_version_status" DEFAULT 'draft',
    "version_updated_at" timestamp(3) with time zone,
    "version_created_at" timestamp(3) with time zone,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "latest" boolean,
    "autosave" boolean
  );

  CREATE TABLE "payload"."_landing_page_v_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" integer NOT NULL,
    "path" varchar NOT NULL,
    "faqs_id" integer
  );

  CREATE TABLE "payload"."faq_page" (
    "id" serial PRIMARY KEY NOT NULL,
    "title" varchar,
    "introduction" varchar,
    "seo_title" varchar,
    "seo_description" varchar,
    "seo_no_index" boolean DEFAULT false,
    "_status" "payload"."enum_faq_page_status" DEFAULT 'draft',
    "updated_at" timestamp(3) with time zone,
    "created_at" timestamp(3) with time zone
  );

  CREATE TABLE "payload"."_faq_page_v" (
    "id" serial PRIMARY KEY NOT NULL,
    "version_title" varchar,
    "version_introduction" varchar,
    "version_seo_title" varchar,
    "version_seo_description" varchar,
    "version_seo_no_index" boolean DEFAULT false,
    "version__status" "payload"."enum__faq_page_v_version_status" DEFAULT 'draft',
    "version_updated_at" timestamp(3) with time zone,
    "version_created_at" timestamp(3) with time zone,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "latest" boolean,
    "autosave" boolean
  );

  ALTER TABLE "payload"."cms_users_sessions" ADD CONSTRAINT "cms_users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."cms_users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_blocks_hero_actions" ADD CONSTRAINT "pages_blocks_hero_actions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."pages_blocks_hero"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_blocks_hero" ADD CONSTRAINT "pages_blocks_hero_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_blocks_features_items" ADD CONSTRAINT "pages_blocks_features_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."pages_blocks_features"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_blocks_features" ADD CONSTRAINT "pages_blocks_features_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_blocks_rich_content" ADD CONSTRAINT "pages_blocks_rich_content_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_blocks_faq" ADD CONSTRAINT "pages_blocks_faq_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_blocks_call_to_action" ADD CONSTRAINT "pages_blocks_call_to_action_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_rels" ADD CONSTRAINT "pages_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."pages_rels" ADD CONSTRAINT "pages_rels_faqs_fk" FOREIGN KEY ("faqs_id") REFERENCES "payload"."faqs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_blocks_hero_actions" ADD CONSTRAINT "_pages_v_blocks_hero_actions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_pages_v_blocks_hero"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_blocks_hero" ADD CONSTRAINT "_pages_v_blocks_hero_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_blocks_features_items" ADD CONSTRAINT "_pages_v_blocks_features_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_pages_v_blocks_features"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_blocks_features" ADD CONSTRAINT "_pages_v_blocks_features_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_blocks_rich_content" ADD CONSTRAINT "_pages_v_blocks_rich_content_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_blocks_faq" ADD CONSTRAINT "_pages_v_blocks_faq_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_blocks_call_to_action" ADD CONSTRAINT "_pages_v_blocks_call_to_action_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v" ADD CONSTRAINT "_pages_v_parent_id_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_rels" ADD CONSTRAINT "_pages_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_pages_v_rels" ADD CONSTRAINT "_pages_v_rels_faqs_fk" FOREIGN KEY ("faqs_id") REFERENCES "payload"."faqs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_faqs_v" ADD CONSTRAINT "_faqs_v_parent_id_faqs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."faqs"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cms_users_fk" FOREIGN KEY ("cms_users_id") REFERENCES "payload"."cms_users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_pages_fk" FOREIGN KEY ("pages_id") REFERENCES "payload"."pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_faqs_fk" FOREIGN KEY ("faqs_id") REFERENCES "payload"."faqs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_cms_users_fk" FOREIGN KEY ("cms_users_id") REFERENCES "payload"."cms_users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_blocks_hero_actions" ADD CONSTRAINT "landing_page_blocks_hero_actions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."landing_page_blocks_hero"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_blocks_hero" ADD CONSTRAINT "landing_page_blocks_hero_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."landing_page"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_blocks_features_items" ADD CONSTRAINT "landing_page_blocks_features_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."landing_page_blocks_features"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_blocks_features" ADD CONSTRAINT "landing_page_blocks_features_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."landing_page"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_blocks_rich_content" ADD CONSTRAINT "landing_page_blocks_rich_content_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."landing_page"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_blocks_faq" ADD CONSTRAINT "landing_page_blocks_faq_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."landing_page"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_blocks_call_to_action" ADD CONSTRAINT "landing_page_blocks_call_to_action_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."landing_page"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_rels" ADD CONSTRAINT "landing_page_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."landing_page"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."landing_page_rels" ADD CONSTRAINT "landing_page_rels_faqs_fk" FOREIGN KEY ("faqs_id") REFERENCES "payload"."faqs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_blocks_hero_actions" ADD CONSTRAINT "_landing_page_v_blocks_hero_actions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_landing_page_v_blocks_hero"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_blocks_hero" ADD CONSTRAINT "_landing_page_v_blocks_hero_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_landing_page_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_blocks_features_items" ADD CONSTRAINT "_landing_page_v_blocks_features_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_landing_page_v_blocks_features"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_blocks_features" ADD CONSTRAINT "_landing_page_v_blocks_features_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_landing_page_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_blocks_rich_content" ADD CONSTRAINT "_landing_page_v_blocks_rich_content_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_landing_page_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_blocks_faq" ADD CONSTRAINT "_landing_page_v_blocks_faq_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_landing_page_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_blocks_call_to_action" ADD CONSTRAINT "_landing_page_v_blocks_call_to_action_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_landing_page_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_rels" ADD CONSTRAINT "_landing_page_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."_landing_page_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_landing_page_v_rels" ADD CONSTRAINT "_landing_page_v_rels_faqs_fk" FOREIGN KEY ("faqs_id") REFERENCES "payload"."faqs"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "cms_users_sessions_order_idx" ON "payload"."cms_users_sessions" USING btree ("_order");
  CREATE INDEX "cms_users_sessions_parent_id_idx" ON "payload"."cms_users_sessions" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "cms_users_auth_user_id_idx" ON "payload"."cms_users" USING btree ("auth_user_id");
  CREATE INDEX "cms_users_updated_at_idx" ON "payload"."cms_users" USING btree ("updated_at");
  CREATE INDEX "cms_users_created_at_idx" ON "payload"."cms_users" USING btree ("created_at");
  CREATE UNIQUE INDEX "cms_users_email_idx" ON "payload"."cms_users" USING btree ("email");
  CREATE INDEX "pages_blocks_hero_actions_order_idx" ON "payload"."pages_blocks_hero_actions" USING btree ("_order");
  CREATE INDEX "pages_blocks_hero_actions_parent_id_idx" ON "payload"."pages_blocks_hero_actions" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_hero_order_idx" ON "payload"."pages_blocks_hero" USING btree ("_order");
  CREATE INDEX "pages_blocks_hero_parent_id_idx" ON "payload"."pages_blocks_hero" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_hero_path_idx" ON "payload"."pages_blocks_hero" USING btree ("_path");
  CREATE INDEX "pages_blocks_features_items_order_idx" ON "payload"."pages_blocks_features_items" USING btree ("_order");
  CREATE INDEX "pages_blocks_features_items_parent_id_idx" ON "payload"."pages_blocks_features_items" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_features_order_idx" ON "payload"."pages_blocks_features" USING btree ("_order");
  CREATE INDEX "pages_blocks_features_parent_id_idx" ON "payload"."pages_blocks_features" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_features_path_idx" ON "payload"."pages_blocks_features" USING btree ("_path");
  CREATE INDEX "pages_blocks_rich_content_order_idx" ON "payload"."pages_blocks_rich_content" USING btree ("_order");
  CREATE INDEX "pages_blocks_rich_content_parent_id_idx" ON "payload"."pages_blocks_rich_content" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_rich_content_path_idx" ON "payload"."pages_blocks_rich_content" USING btree ("_path");
  CREATE INDEX "pages_blocks_faq_order_idx" ON "payload"."pages_blocks_faq" USING btree ("_order");
  CREATE INDEX "pages_blocks_faq_parent_id_idx" ON "payload"."pages_blocks_faq" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_faq_path_idx" ON "payload"."pages_blocks_faq" USING btree ("_path");
  CREATE INDEX "pages_blocks_call_to_action_order_idx" ON "payload"."pages_blocks_call_to_action" USING btree ("_order");
  CREATE INDEX "pages_blocks_call_to_action_parent_id_idx" ON "payload"."pages_blocks_call_to_action" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_call_to_action_path_idx" ON "payload"."pages_blocks_call_to_action" USING btree ("_path");
  CREATE UNIQUE INDEX "pages_slug_idx" ON "payload"."pages" USING btree ("slug");
  CREATE INDEX "pages_updated_at_idx" ON "payload"."pages" USING btree ("updated_at");
  CREATE INDEX "pages_created_at_idx" ON "payload"."pages" USING btree ("created_at");
  CREATE INDEX "pages__status_idx" ON "payload"."pages" USING btree ("_status");
  CREATE INDEX "pages_rels_order_idx" ON "payload"."pages_rels" USING btree ("order");
  CREATE INDEX "pages_rels_parent_idx" ON "payload"."pages_rels" USING btree ("parent_id");
  CREATE INDEX "pages_rels_path_idx" ON "payload"."pages_rels" USING btree ("path");
  CREATE INDEX "pages_rels_faqs_id_idx" ON "payload"."pages_rels" USING btree ("faqs_id");
  CREATE INDEX "_pages_v_blocks_hero_actions_order_idx" ON "payload"."_pages_v_blocks_hero_actions" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_hero_actions_parent_id_idx" ON "payload"."_pages_v_blocks_hero_actions" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_hero_order_idx" ON "payload"."_pages_v_blocks_hero" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_hero_parent_id_idx" ON "payload"."_pages_v_blocks_hero" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_hero_path_idx" ON "payload"."_pages_v_blocks_hero" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_features_items_order_idx" ON "payload"."_pages_v_blocks_features_items" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_features_items_parent_id_idx" ON "payload"."_pages_v_blocks_features_items" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_features_order_idx" ON "payload"."_pages_v_blocks_features" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_features_parent_id_idx" ON "payload"."_pages_v_blocks_features" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_features_path_idx" ON "payload"."_pages_v_blocks_features" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_rich_content_order_idx" ON "payload"."_pages_v_blocks_rich_content" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_rich_content_parent_id_idx" ON "payload"."_pages_v_blocks_rich_content" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_rich_content_path_idx" ON "payload"."_pages_v_blocks_rich_content" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_faq_order_idx" ON "payload"."_pages_v_blocks_faq" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_faq_parent_id_idx" ON "payload"."_pages_v_blocks_faq" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_faq_path_idx" ON "payload"."_pages_v_blocks_faq" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_call_to_action_order_idx" ON "payload"."_pages_v_blocks_call_to_action" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_call_to_action_parent_id_idx" ON "payload"."_pages_v_blocks_call_to_action" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_call_to_action_path_idx" ON "payload"."_pages_v_blocks_call_to_action" USING btree ("_path");
  CREATE INDEX "_pages_v_parent_idx" ON "payload"."_pages_v" USING btree ("parent_id");
  CREATE INDEX "_pages_v_version_version_slug_idx" ON "payload"."_pages_v" USING btree ("version_slug");
  CREATE INDEX "_pages_v_version_version_updated_at_idx" ON "payload"."_pages_v" USING btree ("version_updated_at");
  CREATE INDEX "_pages_v_version_version_created_at_idx" ON "payload"."_pages_v" USING btree ("version_created_at");
  CREATE INDEX "_pages_v_version_version__status_idx" ON "payload"."_pages_v" USING btree ("version__status");
  CREATE INDEX "_pages_v_created_at_idx" ON "payload"."_pages_v" USING btree ("created_at");
  CREATE INDEX "_pages_v_updated_at_idx" ON "payload"."_pages_v" USING btree ("updated_at");
  CREATE INDEX "_pages_v_latest_idx" ON "payload"."_pages_v" USING btree ("latest");
  CREATE INDEX "_pages_v_autosave_idx" ON "payload"."_pages_v" USING btree ("autosave");
  CREATE INDEX "_pages_v_rels_order_idx" ON "payload"."_pages_v_rels" USING btree ("order");
  CREATE INDEX "_pages_v_rels_parent_idx" ON "payload"."_pages_v_rels" USING btree ("parent_id");
  CREATE INDEX "_pages_v_rels_path_idx" ON "payload"."_pages_v_rels" USING btree ("path");
  CREATE INDEX "_pages_v_rels_faqs_id_idx" ON "payload"."_pages_v_rels" USING btree ("faqs_id");
  CREATE UNIQUE INDEX "faqs_slug_idx" ON "payload"."faqs" USING btree ("slug");
  CREATE INDEX "faqs_updated_at_idx" ON "payload"."faqs" USING btree ("updated_at");
  CREATE INDEX "faqs_created_at_idx" ON "payload"."faqs" USING btree ("created_at");
  CREATE INDEX "faqs__status_idx" ON "payload"."faqs" USING btree ("_status");
  CREATE INDEX "_faqs_v_parent_idx" ON "payload"."_faqs_v" USING btree ("parent_id");
  CREATE INDEX "_faqs_v_version_version_slug_idx" ON "payload"."_faqs_v" USING btree ("version_slug");
  CREATE INDEX "_faqs_v_version_version_updated_at_idx" ON "payload"."_faqs_v" USING btree ("version_updated_at");
  CREATE INDEX "_faqs_v_version_version_created_at_idx" ON "payload"."_faqs_v" USING btree ("version_created_at");
  CREATE INDEX "_faqs_v_version_version__status_idx" ON "payload"."_faqs_v" USING btree ("version__status");
  CREATE INDEX "_faqs_v_created_at_idx" ON "payload"."_faqs_v" USING btree ("created_at");
  CREATE INDEX "_faqs_v_updated_at_idx" ON "payload"."_faqs_v" USING btree ("updated_at");
  CREATE INDEX "_faqs_v_latest_idx" ON "payload"."_faqs_v" USING btree ("latest");
  CREATE INDEX "_faqs_v_autosave_idx" ON "payload"."_faqs_v" USING btree ("autosave");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload"."payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload"."payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload"."payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload"."payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload"."payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload"."payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload"."payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_cms_users_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("cms_users_id");
  CREATE INDEX "payload_locked_documents_rels_pages_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("pages_id");
  CREATE INDEX "payload_locked_documents_rels_faqs_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("faqs_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload"."payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload"."payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload"."payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload"."payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload"."payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload"."payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_cms_users_id_idx" ON "payload"."payload_preferences_rels" USING btree ("cms_users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload"."payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload"."payload_migrations" USING btree ("created_at");
  CREATE INDEX "landing_page_blocks_hero_actions_order_idx" ON "payload"."landing_page_blocks_hero_actions" USING btree ("_order");
  CREATE INDEX "landing_page_blocks_hero_actions_parent_id_idx" ON "payload"."landing_page_blocks_hero_actions" USING btree ("_parent_id");
  CREATE INDEX "landing_page_blocks_hero_order_idx" ON "payload"."landing_page_blocks_hero" USING btree ("_order");
  CREATE INDEX "landing_page_blocks_hero_parent_id_idx" ON "payload"."landing_page_blocks_hero" USING btree ("_parent_id");
  CREATE INDEX "landing_page_blocks_hero_path_idx" ON "payload"."landing_page_blocks_hero" USING btree ("_path");
  CREATE INDEX "landing_page_blocks_features_items_order_idx" ON "payload"."landing_page_blocks_features_items" USING btree ("_order");
  CREATE INDEX "landing_page_blocks_features_items_parent_id_idx" ON "payload"."landing_page_blocks_features_items" USING btree ("_parent_id");
  CREATE INDEX "landing_page_blocks_features_order_idx" ON "payload"."landing_page_blocks_features" USING btree ("_order");
  CREATE INDEX "landing_page_blocks_features_parent_id_idx" ON "payload"."landing_page_blocks_features" USING btree ("_parent_id");
  CREATE INDEX "landing_page_blocks_features_path_idx" ON "payload"."landing_page_blocks_features" USING btree ("_path");
  CREATE INDEX "landing_page_blocks_rich_content_order_idx" ON "payload"."landing_page_blocks_rich_content" USING btree ("_order");
  CREATE INDEX "landing_page_blocks_rich_content_parent_id_idx" ON "payload"."landing_page_blocks_rich_content" USING btree ("_parent_id");
  CREATE INDEX "landing_page_blocks_rich_content_path_idx" ON "payload"."landing_page_blocks_rich_content" USING btree ("_path");
  CREATE INDEX "landing_page_blocks_faq_order_idx" ON "payload"."landing_page_blocks_faq" USING btree ("_order");
  CREATE INDEX "landing_page_blocks_faq_parent_id_idx" ON "payload"."landing_page_blocks_faq" USING btree ("_parent_id");
  CREATE INDEX "landing_page_blocks_faq_path_idx" ON "payload"."landing_page_blocks_faq" USING btree ("_path");
  CREATE INDEX "landing_page_blocks_call_to_action_order_idx" ON "payload"."landing_page_blocks_call_to_action" USING btree ("_order");
  CREATE INDEX "landing_page_blocks_call_to_action_parent_id_idx" ON "payload"."landing_page_blocks_call_to_action" USING btree ("_parent_id");
  CREATE INDEX "landing_page_blocks_call_to_action_path_idx" ON "payload"."landing_page_blocks_call_to_action" USING btree ("_path");
  CREATE INDEX "landing_page__status_idx" ON "payload"."landing_page" USING btree ("_status");
  CREATE INDEX "landing_page_rels_order_idx" ON "payload"."landing_page_rels" USING btree ("order");
  CREATE INDEX "landing_page_rels_parent_idx" ON "payload"."landing_page_rels" USING btree ("parent_id");
  CREATE INDEX "landing_page_rels_path_idx" ON "payload"."landing_page_rels" USING btree ("path");
  CREATE INDEX "landing_page_rels_faqs_id_idx" ON "payload"."landing_page_rels" USING btree ("faqs_id");
  CREATE INDEX "_landing_page_v_blocks_hero_actions_order_idx" ON "payload"."_landing_page_v_blocks_hero_actions" USING btree ("_order");
  CREATE INDEX "_landing_page_v_blocks_hero_actions_parent_id_idx" ON "payload"."_landing_page_v_blocks_hero_actions" USING btree ("_parent_id");
  CREATE INDEX "_landing_page_v_blocks_hero_order_idx" ON "payload"."_landing_page_v_blocks_hero" USING btree ("_order");
  CREATE INDEX "_landing_page_v_blocks_hero_parent_id_idx" ON "payload"."_landing_page_v_blocks_hero" USING btree ("_parent_id");
  CREATE INDEX "_landing_page_v_blocks_hero_path_idx" ON "payload"."_landing_page_v_blocks_hero" USING btree ("_path");
  CREATE INDEX "_landing_page_v_blocks_features_items_order_idx" ON "payload"."_landing_page_v_blocks_features_items" USING btree ("_order");
  CREATE INDEX "_landing_page_v_blocks_features_items_parent_id_idx" ON "payload"."_landing_page_v_blocks_features_items" USING btree ("_parent_id");
  CREATE INDEX "_landing_page_v_blocks_features_order_idx" ON "payload"."_landing_page_v_blocks_features" USING btree ("_order");
  CREATE INDEX "_landing_page_v_blocks_features_parent_id_idx" ON "payload"."_landing_page_v_blocks_features" USING btree ("_parent_id");
  CREATE INDEX "_landing_page_v_blocks_features_path_idx" ON "payload"."_landing_page_v_blocks_features" USING btree ("_path");
  CREATE INDEX "_landing_page_v_blocks_rich_content_order_idx" ON "payload"."_landing_page_v_blocks_rich_content" USING btree ("_order");
  CREATE INDEX "_landing_page_v_blocks_rich_content_parent_id_idx" ON "payload"."_landing_page_v_blocks_rich_content" USING btree ("_parent_id");
  CREATE INDEX "_landing_page_v_blocks_rich_content_path_idx" ON "payload"."_landing_page_v_blocks_rich_content" USING btree ("_path");
  CREATE INDEX "_landing_page_v_blocks_faq_order_idx" ON "payload"."_landing_page_v_blocks_faq" USING btree ("_order");
  CREATE INDEX "_landing_page_v_blocks_faq_parent_id_idx" ON "payload"."_landing_page_v_blocks_faq" USING btree ("_parent_id");
  CREATE INDEX "_landing_page_v_blocks_faq_path_idx" ON "payload"."_landing_page_v_blocks_faq" USING btree ("_path");
  CREATE INDEX "_landing_page_v_blocks_call_to_action_order_idx" ON "payload"."_landing_page_v_blocks_call_to_action" USING btree ("_order");
  CREATE INDEX "_landing_page_v_blocks_call_to_action_parent_id_idx" ON "payload"."_landing_page_v_blocks_call_to_action" USING btree ("_parent_id");
  CREATE INDEX "_landing_page_v_blocks_call_to_action_path_idx" ON "payload"."_landing_page_v_blocks_call_to_action" USING btree ("_path");
  CREATE INDEX "_landing_page_v_version_version__status_idx" ON "payload"."_landing_page_v" USING btree ("version__status");
  CREATE INDEX "_landing_page_v_created_at_idx" ON "payload"."_landing_page_v" USING btree ("created_at");
  CREATE INDEX "_landing_page_v_updated_at_idx" ON "payload"."_landing_page_v" USING btree ("updated_at");
  CREATE INDEX "_landing_page_v_latest_idx" ON "payload"."_landing_page_v" USING btree ("latest");
  CREATE INDEX "_landing_page_v_autosave_idx" ON "payload"."_landing_page_v" USING btree ("autosave");
  CREATE INDEX "_landing_page_v_rels_order_idx" ON "payload"."_landing_page_v_rels" USING btree ("order");
  CREATE INDEX "_landing_page_v_rels_parent_idx" ON "payload"."_landing_page_v_rels" USING btree ("parent_id");
  CREATE INDEX "_landing_page_v_rels_path_idx" ON "payload"."_landing_page_v_rels" USING btree ("path");
  CREATE INDEX "_landing_page_v_rels_faqs_id_idx" ON "payload"."_landing_page_v_rels" USING btree ("faqs_id");
  CREATE INDEX "faq_page__status_idx" ON "payload"."faq_page" USING btree ("_status");
  CREATE INDEX "_faq_page_v_version_version__status_idx" ON "payload"."_faq_page_v" USING btree ("version__status");
  CREATE INDEX "_faq_page_v_created_at_idx" ON "payload"."_faq_page_v" USING btree ("created_at");
  CREATE INDEX "_faq_page_v_updated_at_idx" ON "payload"."_faq_page_v" USING btree ("updated_at");
  CREATE INDEX "_faq_page_v_latest_idx" ON "payload"."_faq_page_v" USING btree ("latest");
  CREATE INDEX "_faq_page_v_autosave_idx" ON "payload"."_faq_page_v" USING btree ("autosave");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "payload"."cms_users_sessions" CASCADE;
  DROP TABLE "payload"."cms_users" CASCADE;
  DROP TABLE "payload"."pages_blocks_hero_actions" CASCADE;
  DROP TABLE "payload"."pages_blocks_hero" CASCADE;
  DROP TABLE "payload"."pages_blocks_features_items" CASCADE;
  DROP TABLE "payload"."pages_blocks_features" CASCADE;
  DROP TABLE "payload"."pages_blocks_rich_content" CASCADE;
  DROP TABLE "payload"."pages_blocks_faq" CASCADE;
  DROP TABLE "payload"."pages_blocks_call_to_action" CASCADE;
  DROP TABLE "payload"."pages" CASCADE;
  DROP TABLE "payload"."pages_rels" CASCADE;
  DROP TABLE "payload"."_pages_v_blocks_hero_actions" CASCADE;
  DROP TABLE "payload"."_pages_v_blocks_hero" CASCADE;
  DROP TABLE "payload"."_pages_v_blocks_features_items" CASCADE;
  DROP TABLE "payload"."_pages_v_blocks_features" CASCADE;
  DROP TABLE "payload"."_pages_v_blocks_rich_content" CASCADE;
  DROP TABLE "payload"."_pages_v_blocks_faq" CASCADE;
  DROP TABLE "payload"."_pages_v_blocks_call_to_action" CASCADE;
  DROP TABLE "payload"."_pages_v" CASCADE;
  DROP TABLE "payload"."_pages_v_rels" CASCADE;
  DROP TABLE "payload"."faqs" CASCADE;
  DROP TABLE "payload"."_faqs_v" CASCADE;
  DROP TABLE "payload"."payload_kv" CASCADE;
  DROP TABLE "payload"."payload_locked_documents" CASCADE;
  DROP TABLE "payload"."payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload"."payload_preferences" CASCADE;
  DROP TABLE "payload"."payload_preferences_rels" CASCADE;
  DROP TABLE "payload"."payload_migrations" CASCADE;
  DROP TABLE "payload"."landing_page_blocks_hero_actions" CASCADE;
  DROP TABLE "payload"."landing_page_blocks_hero" CASCADE;
  DROP TABLE "payload"."landing_page_blocks_features_items" CASCADE;
  DROP TABLE "payload"."landing_page_blocks_features" CASCADE;
  DROP TABLE "payload"."landing_page_blocks_rich_content" CASCADE;
  DROP TABLE "payload"."landing_page_blocks_faq" CASCADE;
  DROP TABLE "payload"."landing_page_blocks_call_to_action" CASCADE;
  DROP TABLE "payload"."landing_page" CASCADE;
  DROP TABLE "payload"."landing_page_rels" CASCADE;
  DROP TABLE "payload"."_landing_page_v_blocks_hero_actions" CASCADE;
  DROP TABLE "payload"."_landing_page_v_blocks_hero" CASCADE;
  DROP TABLE "payload"."_landing_page_v_blocks_features_items" CASCADE;
  DROP TABLE "payload"."_landing_page_v_blocks_features" CASCADE;
  DROP TABLE "payload"."_landing_page_v_blocks_rich_content" CASCADE;
  DROP TABLE "payload"."_landing_page_v_blocks_faq" CASCADE;
  DROP TABLE "payload"."_landing_page_v_blocks_call_to_action" CASCADE;
  DROP TABLE "payload"."_landing_page_v" CASCADE;
  DROP TABLE "payload"."_landing_page_v_rels" CASCADE;
  DROP TABLE "payload"."faq_page" CASCADE;
  DROP TABLE "payload"."_faq_page_v" CASCADE;
  DROP TYPE "payload"."enum_pages_status";
  DROP TYPE "payload"."enum__pages_v_version_status";
  DROP TYPE "payload"."enum_faqs_status";
  DROP TYPE "payload"."enum__faqs_v_version_status";
  DROP TYPE "payload"."enum_landing_page_status";
  DROP TYPE "payload"."enum__landing_page_v_version_status";
  DROP TYPE "payload"."enum_faq_page_status";
  DROP TYPE "payload"."enum__faq_page_v_version_status";`)
}
