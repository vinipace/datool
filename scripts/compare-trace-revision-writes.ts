import { mkdir, writeFile } from "node:fs/promises"
import { Pool } from "pg"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "../tests/helpers/postgres"
const target=await createIsolatedPostgres()
const pool=new Pool({connectionString:target.databaseUrl,max:16})
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]
const results:unknown[]=[]
try {
  await migrateIsolatedPostgres(target);await seedTestWorkspace(target)
  await pool.query("INSERT INTO traces(id,project_id,name,operation,status,started_at) SELECT 't-'||i,$1,'Write test','test','running',now() FROM generate_series(1,12)i",[target.projectId])
  for(const concurrency of [1,4,12]) {
    for(const enabled of [false,true,true,false]) {
      await pool.query(`ALTER TABLE traces ${enabled ? "ENABLE":"DISABLE"} TRIGGER trace_read_update`)
      const latencies:number[]=[]
      const started=performance.now()
      await Promise.all(Array.from({length:concurrency},async(_,index)=>{
        for(let i=0;i<100;i++) {
          const before=performance.now()
          await pool.query("UPDATE traces SET name=$1 WHERE project_id=$2 AND id=$3",[`Value ${i}`,target.projectId,`t-${index+1}`])
          latencies.push(performance.now()-before)
        }
      }))
      const elapsedMs=performance.now()-started
      const row={concurrency,enabled,writes:concurrency*100,elapsedMs,writesPerSecond:latencies.length/(elapsedMs/1000),p50Ms:percentile(latencies,0.5),p95Ms:percentile(latencies,0.95)}
      results.push(row);console.info(JSON.stringify(row))
    }
  }
  await mkdir("artifacts/trace-refresh",{recursive:true})
  await writeFile("artifacts/trace-refresh/concurrent-writes.json",JSON.stringify({description:"Independent trace rows in one project; sequential writes per producer; alternating trigger enablement",results},null,2))
} finally {await pool.end();await target.close()}
