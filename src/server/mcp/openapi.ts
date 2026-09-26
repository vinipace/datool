import { z } from "zod"
import { workspaceScopes } from "@/src/lib/auth/permissions"
import { agentOperations } from "./operations"
import outputs from "./output-schemas.json"

/** JSON Schema references are document-relative, even inside an OpenAPI component. */
function inputSchema(name: string, schema: z.ZodType) {
  return JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { io: "input" }), (key, value) =>
      key === "$ref" && typeof value === "string" && value.startsWith("#")
        ? `#/components/schemas/${name}${value.slice(1)}`
        : value
    )
  ) as Record<string, unknown>
}

export function agentOpenApi(origin: string) {
  const schemas: Record<string, unknown> = {
    ...outputs.schemas,
    ApiError: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message", "hint"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            hint: {
              type: "string",
              description:
                "Suggested resolution; mutations must not be retried blindly.",
            },
            details: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  }
  const paths: Record<string, unknown> = {}
  for (const operation of agentOperations) {
    const output = (outputs.operations as Record<string, unknown>)[
      operation.name
    ]
    if (!output)
      throw new Error(
        `Missing response schema for ${operation.name}; run bun run generate:api`
      )
    const schemaName = `${operation.name}_input`
    schemas[schemaName] = inputSchema(schemaName, operation.schema.strict())
    paths[`/api/agent/${operation.name}`] = {
      post: {
        operationId: operation.name,
        description: operation.description,
        tags: ["Agent operations"],
        "x-required-scopes": operation.scopes,
        "x-destructive": operation.destructive,
        security: [{ bearerAuth: [] }, { oauth2: operation.scopes }],
        parameters: [
          {
            name: "x-project-id",
            in: "header",
            required: true,
            description:
              "Project ID authorized by the API key or bound to the OAuth token. The projectId query parameter is also accepted.",
            schema: { type: "string", minLength: 1, maxLength: 200 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Operation result in the data envelope. Application-defined JSON fields remain open; resource fields and pagination are typed.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: { data: output },
                },
              },
            },
          },
          ...Object.fromEntries(
            [400, 401, 402, 403, 404, 409, 413, 422, 429, 500, 503, 504].map(
              (status) => [
                String(status),
                {
                  description: `Request failed (HTTP ${status}); inspect error.code, error.message, and error.hint.`,
                  ...(status === 429
                    ? {
                        headers: {
                          "Retry-After": {
                            description: "Seconds before retrying.",
                            schema: { type: "string" },
                          },
                        },
                      }
                    : {}),
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/ApiError" },
                    },
                  },
                },
              ]
            )
          ),
        },
      },
    }
  }
  return {
    openapi: "3.1.1",
    info: {
      title: "Datool Agent API",
      version: "1.0.0",
      description:
        "The supported agent operation surface shared by REST, MCP, and the CLI. Browser-internal endpoints and MCP JSON-RPC are not described here. Authenticate with an organization API key or a project-bound OAuth token for the /api/cli resource. OAuth uses authorization code with PKCE S256; discover registration and issuer metadata at /.well-known/oauth-authorization-server. Required scopes apply to both authentication methods.",
    },
    servers: [{ url: origin }],
    externalDocs: {
      url: `${origin}/docs`,
      description: "Datool documentation",
    },
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Organization API key (dtk_). Required scopes are listed per operation.",
        },
        oauth2: {
          type: "oauth2",
          description: `PKCE S256 with resource=${origin}/api/cli.`,
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/api/auth/oauth2/authorize`,
              tokenUrl: `${origin}/api/auth/oauth2/token`,
              refreshUrl: `${origin}/api/auth/oauth2/token`,
              scopes: Object.fromEntries(
                workspaceScopes.map((scope) => [scope, scope])
              ),
            },
          },
        },
      },
    },
  }
}
