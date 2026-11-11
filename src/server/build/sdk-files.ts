import { z } from "zod"
import {
  sdkFileInputSchema,
  sdkFileResultSchema,
} from "@/src/lib/build/react-sdk"
import type { BuildContext } from "./context"
import { resolveSdkDrive, sdkConnection } from "./sdk-scope"
import { runAgentSandboxCommand } from "./sandbox-runtime"
import { TracerError } from "@/src/server/tracer/errors"
import { cloudDriveFiles } from "./storage/files"
import { cloudStorage } from "@/src/lib/build/storage"
import { resolveSandboxDrives } from "./drives"

// Runs in the isolated provider environment with only this app drive mounted.
// Reject every symlink component, including broken links; never follow a link
// into the container filesystem. Drive leases exclude concurrent SDK/agent writes.
export const sdkFileProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const fail = message => { console.log(JSON.stringify({ error: message })); process.exit(1); };
try {
  const parts = input.path.split('/').filter(Boolean);
  if (input.path.includes('\\') || input.path.includes('\0') || parts.some(p => p === '.' || p === '..')) fail('Use a path inside the drive.');
  if (!parts.length && input.action !== 'list') fail('The drive root cannot be modified.');
  let current = '/workspace';
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch(e) { if(e.code !== 'ENOENT') throw e; }
    if (stat?.isSymbolicLink()) fail('Symbolic links are not supported.');
    if (i < parts.length - 1 && stat && !stat.isDirectory()) fail('A parent path is not a directory.');
    if (!stat && (input.action === 'mkdir' || (input.action === 'write' && i < parts.length - 1))) fs.mkdirSync(current);
  }
  let result;
  if (input.action === 'list') {
    const names = fs.readdirSync(current).sort();
    if (names.length > 500) fail('This directory exceeds the 500-entry listing limit.');
    result = { entries: names.map(name => { const s = fs.lstatSync(path.join(current,name)); return { name, type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : 'file', size: s.size }; }) };
  } else if (input.action === 'read') {
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { const s = fs.fstatSync(fd); if(!s.isFile() || s.size > 262144) fail('Read requires a regular file of at most 256 KiB.'); result = { content: fs.readFileSync(fd).toString('base64') }; } finally { fs.closeSync(fd); }
  } else if (input.action === 'write') {
    const bytes = Buffer.from(input.content, 'base64');
    if (bytes.length > 262144) fail('Files must be at most 256 KiB.');
    const temporary = path.join(path.dirname(current), '.datool-' + require('node:crypto').randomUUID());
    try { fs.writeFileSync(temporary, bytes, {flag:'wx', mode:0o600}); fs.renameSync(temporary,current); } finally { if(fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    result = { written: true, size: bytes.length };
  } else if (input.action === 'mkdir') { if (!fs.statSync(current).isDirectory()) fail('The path is not a directory.'); result = { created: true }; }
  else if (input.action === 'delete') { const s = fs.lstatSync(current); if(s.isDirectory()) fs.rmdirSync(current); else fs.unlinkSync(current); result = { deleted: true }; }
  console.log(JSON.stringify(result));
} catch(e) { fail(e.code === 'ENOENT' ? 'File or directory not found.' : e.code === 'ENOTEMPTY' ? 'Directory is not empty.' : 'Could not complete the file operation.'); }
`
export async function sdkFiles(context: BuildContext, value: unknown) {
  const input = sdkFileInputSchema.parse(value)
  const { config } = await sdkConnection(context, input.connectionId)
  if (!input.drive)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Choose a drive in the server SDK configuration."
    )
  const driveId = await resolveSdkDrive(context, input, config.sandbox)
  const [drive] = await resolveSandboxDrives(context, {
    ...config.sandbox,
    drives: [{ driveId: driveId!, mountPath: "/workspace" }],
  })
  if (cloudStorage(drive.provider))
    return cloudDriveFiles(context, driveId!, input.request)
  const command = `node -e '${sdkFileProgram.replaceAll("'", "'\\''")}'`
  const result = await runAgentSandboxCommand(
    context,
    {
      ...config.sandbox,
      environment: "node",
      networkAccess: false,
      workingDirectory: "/workspace",
      drives: [{ driveId: driveId!, mountPath: "/workspace" }],
    },
    { command, timeoutSeconds: 30 },
    undefined,
    {
      stdin: JSON.stringify(input.request),
      maxOutputBytes: 512 * 1024,
    }
  )
  if (result.truncated)
    throw new TracerError(
      "VALIDATION_ERROR",
      "The file response exceeds its size limit."
    )
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error("The file operation did not return a result.")
  }
  if (result.exitCode !== 0) {
    const error = z.object({ error: z.string() }).safeParse(parsed)
    throw new TracerError(
      "VALIDATION_ERROR",
      error.success ? error.data.error : "The file operation failed."
    )
  }
  return sdkFileResultSchema.parse(parsed)
}
