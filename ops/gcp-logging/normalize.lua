-- Export operational fields only. Query strings and common credential forms
-- are redacted before leaving the host; this is not a general-purpose DLP filter.
local priorities = {
  ["0"] = "EMERGENCY", ["1"] = "ALERT", ["2"] = "CRITICAL",
  ["3"] = "ERROR", ["4"] = "WARNING", ["5"] = "NOTICE",
  ["6"] = "INFO", ["7"] = "DEBUG"
}

local function redact(message)
  message = message:gsub("([%w+.-]+://)[^%s/@]+:[^%s/@]+@", "%1[REDACTED]@")
  message = message:gsub("([Bb]earer%s+)[%w._~+/-]+=*", "%1[REDACTED]")
  message = message:gsub("([?&])[^%s\"']+", "%1[REDACTED]")
  for _, key in ipairs({"password", "secret", "token", "api_key", "apikey", "authorization", "cookie"}) do
    local pattern = key:gsub("%a", function(c) return "[" .. c:lower() .. c:upper() .. "]" end)
    message = message:gsub("(" .. pattern .. "[\"']?%s*[:=]%s*[\"']?)[^%s,;\"']+", "%1[REDACTED]")
  end
  return message
end

function normalize(tag, timestamp, record)
  local message = tostring(record.MESSAGE or record.log or record.message or "")
  local source = tostring(record.source_file or "")
  local labels = {}
  local severity = priorities[tostring(record.PRIORITY)] or "INFO"
  if record.stream == "stderr" then severity = "ERROR" end
  if record._SYSTEMD_UNIT then labels.unit = tostring(record._SYSTEMD_UNIT) end
  if record.SYSLOG_IDENTIFIER then labels.identifier = tostring(record.SYSLOG_IDENTIFIER) end
  if record.stream then labels.stream = tostring(record.stream) end
  local container = source:match("/containers/(.-)%.([a-f0-9]+)%.log$")
  if container then labels.container = container end
  if tag == "datool.nginx" then
    labels.file = source:match("([^/]+)$") or "nginx"
    if source:match("error%.log$") then severity = "ERROR" end
  end
  return 1, timestamp, {
    message = redact(message),
    severity = severity,
    ["logging.googleapis.com/labels"] = labels,
    ["logging.googleapis.com/logName"] = tag
  }
end
