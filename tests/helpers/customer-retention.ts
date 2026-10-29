import assert from "node:assert/strict"
import { db, analyticsDb } from "../../lib/db"
import { expireCloudCustomerData } from "../../src/server/billing/customer-retention"

const project = process.env.TEST_PROJECT!,
  organization = process.env.TEST_ORGANIZATION!
const connection = crypto.randomUUID(),
  app = crypto.randomUUID()
const old = new Date(Date.now() - 366 * 86400000),
  fresh = new Date()
const q = (query: string, values: unknown[] = []) => db.query(query, values)
const count = async (table: string, where = "true") =>
  Number(
    (await q(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n
  )
try {
  await q(
    "INSERT INTO organization_billing(organization_id,provider,checkout_attempt_id,shopify_shop,shopify_shop_id,shopify_client_id,status,plan,record_limit,current_period_end,access_until) VALUES($1,'shopify','test','fixture.myshopify.com','1','fixture','active','core',100000,now()+interval '30 days',now()+interval '30 days')",
    [organization]
  )
  await q(
    `INSERT INTO build_agents(id,project_id,slug,name,status,current_revision,applied_revision,current_config_json,applied_config_json,created_at,updated_at)
    VALUES('agent',$1,'agent','Agent','active',1,1,'{}','{}',now()::text,now()::text)`,
    [project]
  )
  await q(
    "INSERT INTO build_channel_connection(id,project_id,agent_id,channel,label,status) VALUES($1,$2,'agent','web','Test','connected')",
    [connection, project]
  )
  await q(
    `INSERT INTO build_app_connections(id,project_id,request_key,toolkit,label,provider_user_id,auth_config_id,status)
    VALUES($1,$2,'test','shopify','Test','test','test','active')`,
    [app, project]
  )
  for (const id of [
    "expired",
    "fresh",
    "handoff",
    "uncertain",
    "ticket",
    "job",
    "order",
    "evidence",
    "finished",
  ]) {
    const date = id === "fresh" ? fresh : old
    await q(
      `INSERT INTO build_contacts(id,project_id,email,created_at,updated_at,last_seen_at) VALUES($1,$2,'synthetic@example.test',$3,$3,$3)`,
      [id, project, date]
    )
    await q(
      `INSERT INTO build_contact_identities(id,project_id,contact_id,channel,identity_key) VALUES($1,$2,$1,'web',$1)`,
      [id, project]
    )
    await q(
      `INSERT INTO build_conversations(id,project_id,agent_id,channel,status,metadata_json,created_at,updated_at,last_message_at)
      VALUES($1,$2,'agent','web',$3,$4,$5,$5,$5)`,
      [
        id,
        project,
        id === "handoff" ? "handed_off" : "active",
        JSON.stringify({ contactId: id }),
        date,
      ]
    )
    await q(
      `INSERT INTO build_conversation_turns(id,project_id,conversation_id,request_key,status,owner_fence)
      VALUES($1,$2,$1,$1,$3,0)`,
      [id, project, id === "uncertain" ? "uncertain" : "completed"]
    )
    await q(
      `INSERT INTO build_conversation_messages(id,project_id,conversation_id,turn_id,role,content_json) VALUES($1,$2,$1,$1,'user','"synthetic"')`,
      [id, project]
    )
    await q(
      `INSERT INTO build_channel_message(id,project_id,connection_id,conversation_id,contact_id,direction,idempotency_key,status,content_json,created_at,updated_at)
      VALUES($1,$2,$3,$1,$1,'inbound',$1,'delivered','{"text":"synthetic"}',$4,$4)`,
      [id, project, connection, date]
    )
  }
  await q(
    `INSERT INTO build_inbox_tickets(id,project_id,conversation_id,contact_id,channel,status,created_at,updated_at)
    VALUES('ticket',$1,'ticket','ticket','web','open',$2,$2),('finished',$1,'finished','finished','web','solved',$2,$2)`,
    [project, old]
  )
  await q(
    `INSERT INTO build_channel_job(id,project_id,connection_id,kind,message_id,idempotency_key,status,payload_json)
    VALUES($1,$2,$3,'process_inbound','job','pending','running','{}'),
      ($4,$2,$3,'process_inbound','expired','complete','succeeded','{"text":"synthetic"}')`,
    [crypto.randomUUID(), project, connection, crypto.randomUUID()]
  )
  await q(
    `INSERT INTO build_shopify_order_operations(id,project_id,connection_id,conversation_id,quote_json,settings_json,status,reconcile_after)
    VALUES($1,$2,$3,'order','{}','{}','placed',now()),($4,$2,$3,'expired','{"address":"synthetic"}','{}','placed',NULL)`,
    [crypto.randomUUID(), project, app, crypto.randomUUID()]
  )
  await q(
    `INSERT INTO traces(id,project_id,name,operation,status,started_at) VALUES('pinned',$1,'Evidence','agent','completed',now()::text)`,
    [project]
  )
  await q(
    `UPDATE build_conversation_turns SET trace_id='pinned' WHERE id='evidence'`
  )
  await q(
    `INSERT INTO datasets(id,project_id,name,created_at,updated_at) VALUES('data',$1,'Evidence',now()::text,now()::text)`,
    [project]
  )
  await q(
    `INSERT INTO dataset_items(id,project_id,dataset_id,input_json,source_trace_id,created_at,updated_at)
    VALUES('item',$1,'data','{}','pinned',now()::text,now()::text)`,
    [project]
  )
  await q(
    `INSERT INTO build_collected_data(id,project_id,conversation_id,contact_id,field_key,value_json,created_at)
    VALUES('copy',$1,'expired','expired','email','"synthetic@example.test"',$2)`,
    [project, old]
  )
  await q(
    `INSERT INTO build_operation_events(id,project_id,conversation_id,contact_id,event_type,payload_json,occurred_at)
    VALUES('event',$1,'expired','expired','unanswered_question','{"question":"synthetic"}',$2)`,
    [project, old]
  )
  await q(
    `INSERT INTO build_knowledge_gap_suggestions(id,project_id,fingerprint,question,sample_event_ids)
    VALUES('gap',$1,'test','synthetic','["event"]')`,
    [project]
  )
  await q(
    `INSERT INTO build_channel_transcription(message_id,project_id,operation_id,state,transcript)
    VALUES('expired',$1,$2,'completed','synthetic')`,
    [project, crypto.randomUUID()]
  )
  await q(
    `INSERT INTO build_channel_link(token,project_id,message_id,destination,destination_hash)
    VALUES('abcdefghijklmnopqrstuvwx',$1,'expired','https://example.test/checkout','test')`,
    [project]
  )
  for (const id of ["orphan", "suppressed", "recent"]) {
    await q(
      `INSERT INTO build_contacts(id,project_id,created_at,updated_at,last_seen_at) VALUES($1,$2,$3,$3,$3)`,
      [id, project, id === "recent" ? fresh : old]
    )
  }
  await q(
    `INSERT INTO build_campaign_suppressions(project_id,contact_id,reason) VALUES($1,'suppressed','opted-out')`,
    [project]
  )
  const otherProject = crypto.randomUUID(),
    otherConnection = crypto.randomUUID(),
    otherJob = crypto.randomUUID()
  await q(
    "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Other','other')",
    [otherProject, organization]
  )
  await q(
    `INSERT INTO build_agents(id,project_id,slug,name,status,current_revision,applied_revision,current_config_json,applied_config_json,created_at,updated_at)
    VALUES('other-agent',$1,'agent','Agent','active',1,1,'{}','{}',now()::text,now()::text)`,
    [otherProject]
  )
  await q(
    "INSERT INTO build_channel_connection(id,project_id,agent_id,channel,label,status) VALUES($1,$2,'other-agent','web','Other','connected')",
    [otherConnection, otherProject]
  )
  await q(
    `INSERT INTO build_channel_job(id,project_id,connection_id,kind,idempotency_key,status,payload_json)
    VALUES($1,$2,$3,'resume_wait','foreign-reference','succeeded','{"conversationId":"expired"}')`,
    [otherJob, otherProject, otherConnection]
  )

  // Self-hosted operators must opt into Cloud retention; no accidental deletion.
  process.env.DATOOL_BILLING_ENABLED = "false"
  assert.deepEqual(await expireCloudCustomerData(), {
    conversations: 0,
    contacts: 0,
  })
  assert.equal(await count("build_conversations"), 9)
  process.env.DATOOL_BILLING_ENABLED = "true"
  // A tenant with no Cloud billing record is not swept even on a Cloud server.
  await q("UPDATE organization_billing SET provider='stripe',customer_id=NULL")
  assert.deepEqual(await expireCloudCustomerData(), {
    conversations: 0,
    contacts: 0,
  })
  await q("UPDATE organization_billing SET provider='shopify'")
  const first = await expireCloudCustomerData(1)
  assert.equal(first.conversations, 1)
  assert.equal(first.contacts, 1)
  const second = await expireCloudCustomerData()
  assert.equal(second.conversations, 1)
  assert.equal(second.contacts, 2)
  assert.deepEqual(
    (await q("SELECT id FROM build_conversations ORDER BY id")).rows.map(
      (r) => r.id
    ),
    ["evidence", "fresh", "handoff", "job", "order", "ticket", "uncertain"]
  )
  assert.deepEqual(
    (await q("SELECT id FROM build_contacts ORDER BY id")).rows.map(
      (r) => r.id
    ),
    [
      "evidence",
      "fresh",
      "handoff",
      "job",
      "order",
      "recent",
      "suppressed",
      "ticket",
      "uncertain",
    ]
  )
  for (const table of [
    "build_conversation_messages",
    "build_conversation_turns",
    "build_channel_message",
  ])
    assert.equal(
      await count(table, "conversation_id IN ('expired','finished')"),
      0
    )
  for (const table of [
    "build_collected_data",
    "build_operation_events",
    "build_knowledge_gap_suggestions",
    "build_channel_transcription",
    "build_channel_link",
  ])
    assert.equal(
      await count(table),
      0,
      `${table} must not leave a customer-data copy`
    )
  assert.equal(await count("build_channel_job"), 2)
  assert.equal(
    (await q("SELECT 1 FROM build_channel_job WHERE id=$1", [otherJob]))
      .rowCount,
    1,
    "A payload reference cannot authorize deleting another project's job"
  )
  assert.equal(await count("build_shopify_order_operations"), 1)
  assert.equal(await count("build_inbox_tickets"), 1)
  assert.equal(
    await count("build_contact_identities", "contact_id='expired'"),
    0
  )
  assert.equal(await count("build_campaign_suppressions"), 1)
  assert.deepEqual(await expireCloudCustomerData(), {
    conversations: 0,
    contacts: 0,
  })
  await assert.rejects(() => expireCloudCustomerData(0))
  console.log("PASS customer retention")
} finally {
  await db.end()
  await analyticsDb.end()
}
