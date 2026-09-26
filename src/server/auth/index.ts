import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
export async function getOrganizationAuth() {
  return { auth: getAuth(), database: db }
}
