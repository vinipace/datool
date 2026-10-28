import { MigrateUpArgs, MigrateDownArgs, sql } from "@payloadcms/db-postgres"

// Agent landing questions move from inline rows into the FAQs collection so
// each one gets its own page. This copy of the questions is fixed in time;
// edited questions without a match keep their text under a generated slug.
const questions = [
  {
    previous: "Which WhatsApp number does it use?",
    slug: "which-whatsapp-number-does-an-agent-use",
    question: "Which WhatsApp number does a Datool agent use?",
    answer:
      "Your business's own WhatsApp number, connected in Datool. Customers keep messaging the number they already know.",
  },
  {
    previous: "How do I add it to my site?",
    slug: "how-do-i-add-an-agent-to-my-website",
    question: "How do I add a Datool agent to my website?",
    answer:
      "Add the chat widget to your site or link to the hosted help page. You choose its position and appearance.",
  },
  {
    previous: "How does it know my products?",
    slug: "how-does-a-sales-agent-know-my-products",
    question: "How does a sales agent know my products?",
    answer:
      "You connect your catalog as a data source. It recommends only from what you've connected, so it never suggests something you don't sell.",
  },
  {
    previous: "Can customers buy inside the chat?",
    slug: "can-customers-buy-inside-the-chat",
    question: "Can customers buy inside the chat?",
    answer:
      "It sends checkout links from your store, and it can call your own APIs for things like order lookups.",
  },
  {
    previous: "Where does it get its answers?",
    slug: "where-does-a-support-agent-get-its-answers",
    question: "Where does a support agent get its answers?",
    answer:
      "From the help articles, policies and data sources you connect. It can also call your own APIs to look up orders or accounts.",
  },
  {
    previous: "What happens when it can't solve something?",
    slug: "what-happens-when-an-agent-cannot-solve-something",
    question: "What happens when an agent can't solve something?",
    answer:
      "It hands the conversation to your team in the inbox, with a summary and everything it already collected.",
  },
  {
    previous: "Does it replace my team?",
    slug: "does-an-ai-agent-replace-my-team",
    question: "Does an AI agent replace my team?",
    answer:
      "No. It takes the repetitive conversations so your team spends its time on the ones that need a person.",
  },
  {
    previous: "Can I control what it says?",
    slug: "can-i-control-what-an-agent-says",
    question: "Can I control what an agent says?",
    answer:
      "Yes. You write its instructions, choose its data sources and set guardrails for topics it should avoid. You can test it on real conversations before it goes live.",
  },
  {
    previous: "How do I get started?",
    slug: "how-do-i-get-started-with-an-agent",
    question: "How do I get started with an agent?",
    answer:
      "Request a demo on WhatsApp. We set it up with your own content so you can see real answers before you decide.",
  },
  {
    previous: "How does it get into my product?",
    slug: "how-does-a-product-guide-get-into-my-app",
    question: "How does a product guide get into my app?",
    answer:
      "You add the chat widget to your app, then define the actions it can run there and the APIs it can call.",
  },
  {
    previous: "Can it click things for users?",
    slug: "can-a-product-guide-click-things-for-users",
    question: "Can a product guide click things for users?",
    answer:
      "It can run client-side actions you define, such as opening a page or highlighting an element, and call your APIs.",
  },
  {
    previous: "Can it use each user's own data?",
    slug: "can-a-product-guide-use-each-users-data",
    question: "Can a product guide use each user's own data?",
    answer:
      "Yes, through the APIs you connect. It looks up the account it's helping, so answers fit that user instead of a generic article.",
  },
]

type InlineQuestion = {
  parent: number
  order: number
  question: string
  answer: string | null
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)

function richText(text: string) {
  return {
    root: {
      type: "root",
      format: "" as const,
      indent: 0,
      version: 1,
      direction: "ltr" as const,
      children: [
        {
          type: "paragraph",
          format: "" as const,
          indent: 0,
          version: 1,
          direction: "ltr" as const,
          textFormat: 0,
          children: [
            {
              type: "text",
              text,
              format: 0,
              detail: 0,
              mode: "normal",
              style: "",
              version: 1,
            },
          ],
        },
      ],
    },
  }
}

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  const inline = (
    await db.execute(sql`
      SELECT "_parent_id" AS parent, "_order" AS "order", "question", "answer"
      FROM "payload"."agent_lp_faq_items"
      ORDER BY "_parent_id", "_order"`)
  ).rows as InlineQuestion[]

  await db.execute(sql`
   CREATE TABLE "payload"."agent_lp_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"faqs_id" integer
  );

  CREATE TABLE "payload"."_agent_lp_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"faqs_id" integer
  );

  ALTER TABLE "payload"."agent_lp_rels" ADD CONSTRAINT "agent_lp_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."agent_lp"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."agent_lp_rels" ADD CONSTRAINT "agent_lp_rels_faqs_fk" FOREIGN KEY ("faqs_id") REFERENCES "payload"."faqs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v_rels" ADD CONSTRAINT "_agent_lp_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."_agent_lp_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v_rels" ADD CONSTRAINT "_agent_lp_v_rels_faqs_fk" FOREIGN KEY ("faqs_id") REFERENCES "payload"."faqs"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "agent_lp_rels_order_idx" ON "payload"."agent_lp_rels" USING btree ("order");
  CREATE INDEX "agent_lp_rels_parent_idx" ON "payload"."agent_lp_rels" USING btree ("parent_id");
  CREATE INDEX "agent_lp_rels_path_idx" ON "payload"."agent_lp_rels" USING btree ("path");
  CREATE INDEX "agent_lp_rels_faqs_id_idx" ON "payload"."agent_lp_rels" USING btree ("faqs_id");
  CREATE INDEX "_agent_lp_v_rels_order_idx" ON "payload"."_agent_lp_v_rels" USING btree ("order");
  CREATE INDEX "_agent_lp_v_rels_parent_idx" ON "payload"."_agent_lp_v_rels" USING btree ("parent_id");
  CREATE INDEX "_agent_lp_v_rels_path_idx" ON "payload"."_agent_lp_v_rels" USING btree ("path");
  CREATE INDEX "_agent_lp_v_rels_faqs_id_idx" ON "payload"."_agent_lp_v_rels" USING btree ("faqs_id");
  ALTER TABLE "payload"."agent_lp_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."_agent_lp_v_rels" DISABLE ROW LEVEL SECURITY;`)

  // Agent questions follow the general ones in the FAQ index.
  const [{ next }] = (
    await db.execute(
      sql`SELECT COALESCE(MAX("order"), 0) + 1 AS next FROM "payload"."faqs"`
    )
  ).rows as { next: number }[]
  const ids = new Map<string, number>()
  async function faqFor(item: InlineQuestion) {
    const known = questions.find((entry) => entry.previous === item.question)
    const slug = known?.slug ?? slugify(item.question)
    if (ids.has(slug)) return ids.get(slug)!
    const existing = await payload.find({
      collection: "faqs",
      where: { slug: { equals: slug } },
      draft: true,
      limit: 1,
      depth: 0,
      req,
    })
    const doc =
      existing.docs[0] ??
      (await payload.create({
        collection: "faqs",
        data: {
          slug,
          question: known?.question ?? item.question,
          answer: richText(known?.answer ?? item.answer ?? ""),
          order: Number(next) + ids.size,
          _status: "published",
        },
        req,
      }))
    ids.set(slug, doc.id)
    return doc.id
  }

  for (const item of inline) {
    const faq = await faqFor(item)
    await db.execute(sql`
      INSERT INTO "payload"."agent_lp_rels" ("order", "parent_id", "path", "faqs_id")
      VALUES (${item.order}, ${item.parent}, 'faq.items', ${faq})`)
    // Drafts and the admin read the latest version.
    await db.execute(sql`
      INSERT INTO "payload"."_agent_lp_v_rels" ("order", "parent_id", "path", "faqs_id")
      SELECT ${item.order}, MAX("id"), 'version.faq.items', ${faq}
      FROM "payload"."_agent_lp_v" WHERE "parent_id" = ${item.parent}
      HAVING MAX("id") IS NOT NULL`)
  }

  await db.execute(sql`
   DROP TABLE "payload"."agent_lp_faq_items" CASCADE;
  DROP TABLE "payload"."_agent_lp_v_version_faq_items" CASCADE;`)
}

// Restores the inline tables with each linked question's text. The FAQs stay.
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "payload"."agent_lp_faq_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"question" varchar,
  	"answer" varchar
  );

  CREATE TABLE "payload"."_agent_lp_v_version_faq_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"question" varchar,
  	"answer" varchar,
  	"_uuid" varchar
  );

  ALTER TABLE "payload"."agent_lp_faq_items" ADD CONSTRAINT "agent_lp_faq_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."agent_lp"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."_agent_lp_v_version_faq_items" ADD CONSTRAINT "_agent_lp_v_version_faq_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "payload"."_agent_lp_v"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "agent_lp_faq_items_order_idx" ON "payload"."agent_lp_faq_items" USING btree ("_order");
  CREATE INDEX "agent_lp_faq_items_parent_id_idx" ON "payload"."agent_lp_faq_items" USING btree ("_parent_id");
  CREATE INDEX "_agent_lp_v_version_faq_items_order_idx" ON "payload"."_agent_lp_v_version_faq_items" USING btree ("_order");
  CREATE INDEX "_agent_lp_v_version_faq_items_parent_id_idx" ON "payload"."_agent_lp_v_version_faq_items" USING btree ("_parent_id");
  ALTER TABLE "payload"."agent_lp_faq_items" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload"."_agent_lp_v_version_faq_items" DISABLE ROW LEVEL SECURITY;

  INSERT INTO "payload"."agent_lp_faq_items" ("_order", "_parent_id", "id", "question", "answer")
  SELECT r."order", r."parent_id", md5(random()::text || r."id"), f."question",
    (SELECT string_agg(v #>> '{}', '') FROM jsonb_path_query(f."answer"::jsonb, 'strict $.**.text') AS v)
  FROM "payload"."agent_lp_rels" r JOIN "payload"."faqs" f ON f."id" = r."faqs_id"
  WHERE r."path" = 'faq.items';

  DROP TABLE "payload"."agent_lp_rels" CASCADE;
  DROP TABLE "payload"."_agent_lp_v_rels" CASCADE;`)
}
